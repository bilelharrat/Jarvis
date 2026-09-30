"""Location and traffic from Apple's frameworks (CoreLocation, MapKit): no keys, no account.

Apple delivers these answers on the main thread's run loop, which the app's asyncio loop
doesn't run, so each call is a short helper process:

    python -m jarvis.maps locate          (only works inside an app bundle; the app window
                                          normally supplies the position instead)
    python -m jarvis.maps reverse <lat> <lon>
    python -m jarvis.maps eta <lat> <lon> <destination> [driving|walking|transit] [arrive]
    python -m jarvis.maps nearby <lat> <lon> <what> [radius metres] [how many]
    python -m jarvis.maps geocode <place> [<lat> <lon>]

arrive (seconds since 1970): the time to be there by; the answer then says when to set
off, as Apple Maps expects the roads (or the timetable) to be then. Each prints one JSON
object. macOS asks once for location access, on behalf of the J.A.R.V.I.S. app.
"""

from __future__ import annotations

import asyncio
import json
import math
import re
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


def eta(
    lat: float, lon: float, destination: str, mode: str = "driving", arrive: float | None = None
) -> dict[str, Any]:
    """Minutes, distance and, when Maps says, when to set off and when you'd arrive
    (epoch seconds): with arrive, the trip that gets there by then (a train's
    timetable)."""
    import CoreLocation
    import MapKit
    from Foundation import NSDate

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
        if arrive:  # "be there by": the roads (or the timetable) as they'll be then
            request.setArrivalDate_(NSDate.dateWithTimeIntervalSince1970_(arrive))

        def got(response2, error2):
            if error2 is not None:
                done["error"] = str(error2.localizedDescription())
            else:
                done["minutes"] = round(response2.expectedTravelTime() / 60)
                done["km"] = round(response2.distance() / 1000, 1)
                done["miles"] = round(response2.distance() / 1609.34, 1)
                for key, getter in (
                    ("depart", "expectedDepartureDate"),
                    ("arrive", "expectedArrivalDate"),
                ):
                    moment = getattr(response2, getter, lambda: None)()
                    if moment is not None:
                        done[key] = round(moment.timeIntervalSince1970())
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


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Metres between two points, as the crow flies (haversine)."""
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def _category(raw: Any) -> str:
    """MapKit's point-of-interest category in words: MKPOICategoryPublicTransport ->
    "public transport"."""
    name = re.sub(r"^MKPOICategory", "", str(raw or ""))
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", name).lower()


def _address(placemark: Any) -> str:
    number, street = placemark.subThoroughfare(), placemark.thoroughfare()
    parts = [f"{number} {street}" if number and street else street or ""]
    parts += [placemark.locality() or "", placemark.administrativeArea() or ""]
    return ", ".join(str(p) for p in parts if p)


def place_row(item: Any, here: tuple[float, float] | None = None) -> dict[str, Any]:
    """One MKMapItem as the tools use it: name, kind, address, phone, web page, where it is
    and, from here, how far."""
    placemark = item.placemark()
    where = placemark.coordinate()
    row: dict[str, Any] = {
        "name": str(item.name() or ""),
        "address": _address(placemark),
        "lat": float(where.latitude),
        "lon": float(where.longitude),
    }
    category = _category(item.pointOfInterestCategory())
    if category:
        row["category"] = category
    phone = item.phoneNumber()
    if phone:
        row["phone"] = str(phone)
    url = item.url()
    if url is not None:
        row["url"] = str(url.absoluteString())
    if here is not None:
        row["meters"] = round(distance_m(here[0], here[1], row["lat"], row["lon"]))
    return row


def _search(
    query: str, lat: float | None, lon: float | None, radius_m: float, kinds: int | None = None
) -> dict[str, Any]:
    import CoreLocation
    import MapKit

    done: dict[str, Any] = {}
    request = MapKit.MKLocalSearchRequest.alloc().init()
    request.setNaturalLanguageQuery_(query)
    if lat is not None and lon is not None:
        here = CoreLocation.CLLocationCoordinate2DMake(lat, lon)
        span = max(200.0, radius_m) * 2
        request.setRegion_(MapKit.MKCoordinateRegionMakeWithDistance(here, span, span))
    if kinds is not None:
        request.setResultTypes_(kinds)

    def found(response, error):
        if error is not None or not response or not response.mapItems():
            done.update(error=f"Apple Maps found nothing for {query!r}.", end=True)
            return
        origin = (lat, lon) if lat is not None and lon is not None else None
        done["places"] = [place_row(item, origin) for item in response.mapItems()]
        done["end"] = True

    MapKit.MKLocalSearch.alloc().initWithRequest_(request).startWithCompletionHandler_(found)
    _spin(done, 15)
    if "places" not in done and "error" not in done:
        done["error"] = "Apple Maps didn't answer in time."
    done.pop("end", None)
    return done


def nearby(
    lat: float, lon: float, query: str, radius_m: float = 5000, limit: int = 8
) -> dict[str, Any]:
    """Places matching words ("coffee", "pharmacy", "EV charging") around a point, in Apple
    Maps' order, each with its distance from the point."""
    import MapKit

    kinds = MapKit.MKLocalSearchResultTypePointOfInterest | MapKit.MKLocalSearchResultTypeAddress
    found = _search(query, lat, lon, radius_m, kinds)
    if "places" in found:
        found["places"] = found["places"][: max(1, min(limit, 15))]
    return found


def geocode(query: str, lat: float | None = None, lon: float | None = None) -> dict[str, Any]:
    """The one place a name or address means (the nearest reading of it, around a point when
    one is given): {name, address, lat, lon} or {error}."""
    found = _search(query, lat, lon, 100_000)
    if "places" not in found:
        return found
    return found["places"][0]


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
        await proc.wait()  # reap it
        return {"error": "Location services took too long."}
    try:
        return json.loads(out.decode().strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"error": "Location helper failed."}


def main(argv: list[str] | None = None) -> None:
    args = sys.argv if argv is None else argv
    command = args[1] if len(args) > 1 else ""
    try:
        if command == "locate":
            result = locate()
        elif command == "reverse" and len(args) >= 4:
            result = reverse_geocode(float(args[2]), float(args[3]))
        elif command == "eta" and len(args) >= 5:
            result = eta(
                float(args[2]),
                float(args[3]),
                args[4],
                args[5] if len(args) > 5 else "driving",
                float(args[6]) if len(args) > 6 and args[6] else None,
            )
        elif command == "nearby" and len(args) >= 5:
            result = nearby(
                float(args[2]),
                float(args[3]),
                args[4],
                float(args[5]) if len(args) > 5 else 5000,
                int(args[6]) if len(args) > 6 else 8,
            )
        elif command == "geocode" and len(args) >= 3:
            near = (float(args[3]), float(args[4])) if len(args) >= 5 else (None, None)
            result = geocode(args[2], *near)
        else:
            result = {
                "error": "usage: locate | reverse <lat> <lon> | eta <lat> <lon> <destination> "
                "[mode] [arrive] | nearby <lat> <lon> <what> [radius] [n] | geocode <place> "
                "[<lat> <lon>]"
            }
    except ValueError as exc:  # a number that isn't one
        result = {"error": f"Bad request for the maps helper: {exc}"}
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
