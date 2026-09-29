"""Location and traffic from Apple's frameworks (CoreLocation, MapKit): no keys, no account.

Apple delivers these answers on the main thread's run loop, which the app's asyncio loop
doesn't run, so each call is a short helper process:

    python -m jarvis.maps locate          (only works inside an app bundle; the app window
                                          normally supplies the position instead)
    python -m jarvis.maps reverse <lat> <lon>
    python -m jarvis.maps eta <lat> <lon> <destination> [driving|walking|transit]

Each prints one JSON object. macOS asks once for location access, on behalf of the
J.A.R.V.I.S. app.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from typing import Any


def _spin(done: dict, seconds: float) -> None:
    from Foundation import NSDate, NSRunLoop

    end = time.time() + seconds
    while not done.get("end") and time.time() < end:
        NSRunLoop.currentRunLoop().runUntilDate_(NSDate.dateWithTimeIntervalSinceNow_(0.1))


def locate(timeout: float = 12) -> dict[str, Any]:
    import CoreLocation
    from Foundation import NSObject

    done: dict[str, Any] = {}

    class Delegate(NSObject):
        def locationManager_didUpdateLocations_(self, manager, locations):
            loc = locations[-1]
            c = loc.coordinate()
            done.update(lat=c.latitude, lon=c.longitude, accuracy=loc.horizontalAccuracy())
            done["end"] = True

        def locationManager_didFailWithError_(self, manager, error):
            done.update(error=str(error.localizedDescription()), end=True)

        def locationManagerDidChangeAuthorization_(self, manager):
            status = manager.authorizationStatus()
            if status in (1, 2):  # restricted, denied
                done.update(
                    error="Location access is off for J.A.R.V.I.S. (System Settings > Privacy & Security > Location Services).",
                    end=True,
                )
            elif status in (3, 4):  # authorized
                manager.requestLocation()

    delegate = Delegate.alloc().init()
    manager = CoreLocation.CLLocationManager.alloc().init()
    manager.setDelegate_(delegate)
    manager.setDesiredAccuracy_(CoreLocation.kCLLocationAccuracyHundredMeters)
    if manager.authorizationStatus() == 0:  # not determined yet
        manager.requestWhenInUseAuthorization()
    else:
        manager.requestLocation()
    _spin(done, timeout)
    del delegate  # kept alive through the spin above
    if "lat" not in done:
        return {"error": done.get("error", "Couldn't get a location fix.")}
    place = reverse_geocode(done["lat"], done["lon"])
    return {k: v for k, v in {**done, **place}.items() if k != "end"}


def reverse_geocode(lat: float, lon: float) -> dict[str, Any]:
    import CoreLocation

    done: dict[str, Any] = {}

    def handler(placemarks, error):
        if placemarks:
            p = placemarks[0]
            done.update(
                city=p.locality() or "",
                region=p.administrativeArea() or "",
                country=p.ISOcountryCode() or "",
                neighborhood=p.subLocality() or "",
                street=p.thoroughfare() or "",
            )
        done["end"] = True

    CoreLocation.CLGeocoder.alloc().init().reverseGeocodeLocation_completionHandler_(
        CoreLocation.CLLocation.alloc().initWithLatitude_longitude_(lat, lon), handler
    )
    _spin(done, 8)
    done.pop("end", None)
    return done


def eta(lat: float, lon: float, destination: str, mode: str = "driving") -> dict[str, Any]:
    import CoreLocation
    import MapKit

    done: dict[str, Any] = {}
    here = CoreLocation.CLLocationCoordinate2DMake(lat, lon)
    origin = MapKit.MKMapItem.alloc().initWithPlacemark_(
        MapKit.MKPlacemark.alloc().initWithCoordinate_(here)
    )
    transport = {
        "driving": MapKit.MKDirectionsTransportTypeAutomobile,
        "walking": MapKit.MKDirectionsTransportTypeWalking,
        "transit": MapKit.MKDirectionsTransportTypeTransit,
    }.get(mode, MapKit.MKDirectionsTransportTypeAutomobile)

    search = MapKit.MKLocalSearchRequest.alloc().init()
    search.setNaturalLanguageQuery_(destination)
    search.setRegion_(MapKit.MKCoordinateRegionMakeWithDistance(here, 150_000, 150_000))

    def found(response, error):
        if error is not None or not response or not response.mapItems():
            done.update(error=f"I couldn't find {destination!r} on the map.", end=True)
            return
        dest = response.mapItems()[0]
        placemark = dest.placemark()
        done["destination"] = dest.name()
        done["address"] = ", ".join(
            p
            for p in (
                placemark.thoroughfare(),
                placemark.locality(),
                placemark.administrativeArea(),
            )
            if p
        )
        request = MapKit.MKDirectionsRequest.alloc().init()
        request.setSource_(origin)
        request.setDestination_(dest)
        request.setTransportType_(transport)

        def got(response2, error2):
            if error2 is not None:
                done["error"] = str(error2.localizedDescription())
            else:
                done["minutes"] = round(response2.expectedTravelTime() / 60)
                done["km"] = round(response2.distance() / 1000, 1)
                done["miles"] = round(response2.distance() / 1609.34, 1)
            done["end"] = True

        MapKit.MKDirections.alloc().initWithRequest_(request).calculateETAWithCompletionHandler_(
            got
        )

    MapKit.MKLocalSearch.alloc().initWithRequest_(search).startWithCompletionHandler_(found)
    _spin(done, 15)
    if "minutes" not in done and "error" not in done:
        done["error"] = "Apple Maps didn't answer in time."
    done.pop("end", None)
    done["mode"] = mode
    return done


async def run_helper(*args: str, timeout: float = 25) -> dict[str, Any]:
    """Run this module as a helper process from the app and parse its answer."""
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "jarvis.maps",
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except TimeoutError:
        proc.kill()
        return {"error": "Location services took too long."}
    try:
        return json.loads(out.decode().strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"error": "Location helper failed."}


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "locate":
        result = locate()
    elif command == "reverse" and len(sys.argv) >= 4:
        result = reverse_geocode(float(sys.argv[2]), float(sys.argv[3]))
    elif command == "eta" and len(sys.argv) >= 5:
        result = eta(
            float(sys.argv[2]),
            float(sys.argv[3]),
            sys.argv[4],
            sys.argv[5] if len(sys.argv) > 5 else "driving",
        )
    else:
        result = {"error": "usage: locate | eta <lat> <lon> <destination> [mode]"}
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
