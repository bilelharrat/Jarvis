"""Share live's limits, round 2 (features/code_share.py). S1: the share-wide bucket was
spent first, even by requests the address's bucket then refused, so one address sending fast
drained the whole share and the teammate it was made for got 429s; the viewer's, then the
address's, then the share's are checked now, each spent only when the ones before allow.
S1b: a LAN neighbour with a few addresses (aliases are free) took all MAX_VIEWERS seats; one
address gets VIEWERS_PER_ADDRESS. In-process ASGI, no ports."""

from starlette.testclient import TestClient
from test_code_share import hub, projects, session, share_url  # noqa: F401

from jarvis.remote import Devices, create_remote_app


def token_of(hub):
    return share_url(hub).rsplit("/", 1)[1]


def client_at(hub, tmp_path, ip):
    return TestClient(create_remote_app(hub, Devices(tmp_path / f"devices-{ip}.json")),
                      base_url="https://testserver", client=(ip, 50000))


async def test_one_address_flooding_locks_every_viewer_out(hub, projects, tmp_path):  # noqa: F811
    task, _ = await session(hub, projects)
    hub.code_share.cmd_start({"id": task.id})
    token = token_of(hub)
    teammate = client_at(hub, tmp_path, "10.0.0.7")
    first = teammate.get(f"/share/{token}/state", params={"v": "teammate-01"}).status_code
    attacker = client_at(hub, tmp_path, "10.0.0.66")
    codes = [attacker.get(f"/share/{token}/state", params={"v": "attacker-01"}).status_code
             for _ in range(600)]
    after = [teammate.get(f"/share/{token}/state", params={"v": "teammate-01"}).status_code
             for _ in range(3)]
    assert codes.count(429) > 0  # (the flood itself is refused)
    assert first == 200
    assert 200 in after, "one address's refused requests drained the share: its teammate is locked out"


async def test_viewer_slots_from_many_addresses(hub, projects, tmp_path):  # noqa: F811
    """A LAN neighbour with a few addresses (aliases are free) takes all MAX_VIEWERS seats."""
    task, _ = await session(hub, projects)
    hub.code_share.cmd_start({"id": task.id})
    token = token_of(hub)
    taken = 0
    for a in range(6):
        c = client_at(hub, tmp_path, f"10.0.1.{a}")
        for v in range(4):
            if c.get(f"/share/{token}/state", params={"v": f"squat-{a:02d}-{v:02d}"}).status_code == 200:
                taken += 1
    teammate = client_at(hub, tmp_path, "10.0.0.7")
    got = teammate.get(f"/share/{token}/state", params={"v": "teammate-01"}).status_code
    assert taken <= 6 * 3
    assert got == 200, "every seat taken by one neighbour's few addresses"
