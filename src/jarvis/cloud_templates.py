"""Setup templates for the owner's own cloud machines (features/code_provision.py runs them).

Eden Code's cloud runs stay bring-your-own: a machine the owner pays for, in an account of
theirs, signed in to their own Claude account, so their code and their prompts go nowhere
Eden runs. That's the privacy angle, and it stays. What used to be missing is the setup:
the owner had to make the server, its user, its SSH key and its config by hand. Here are
templates for the common providers, each a list of the provider's own CLI commands (the
owner's own login, never a key Eden keeps), so the plan can be shown word for word before
anything is made, and run only after a yes:

    gcp       Google Cloud Compute Engine   gcloud
    aws       AWS EC2                       aws
    hetzner   Hetzner Cloud                 hcloud
    do        DigitalOcean Droplets         doctl
    fly       Fly.io Machines               flyctl (or fly)
    docker    Docker or OrbStack, here      docker      (free; stops when the Mac sleeps)
    tart      A Tart VM, here               tart        (free; Apple silicon)

Every machine gets the same first-boot script (bootstrap()): a user "eden" that only the
owner's dedicated key gets into (~/.ssh/eden_cloud_ed25519, made on the Mac, its private
half never leaves it), git, tmux and the Claude Code CLI, and an idle watchdog that powers
the machine off after the minutes set in Settings with no Claude Code run and nobody
connected, so a forgotten machine stops costing compute even with the Mac shut. Providers
that bill a server while it's off (Hetzner, DigitalOcean) get no watchdog (powering off
saves nothing there and only makes the machine unreachable); for those, the cap is Eden's
"delete when idle", which only ever deletes a machine no hand-off work is on.

Warm environments: a machine can be saved as an image (a disk image, snapshot, committed
container or cloned VM, per provider) after a project's setup has run in it; a new machine
for that project starts from it, its dependencies and caches already there.

Prices are list prices checked in October 2026 for the default region, in US dollars, and
only ever shown as an estimate ("check the provider's pricing page"): Eden never bills or
meters these machines; the provider bills the owner directly.

Everything here is text: no process is run, no file is written, no model is called.
"""

from __future__ import annotations

import base64
import hashlib
import re
import shlex
from dataclasses import dataclass, field
from typing import Any

KEY_NAME = "eden_cloud_ed25519"  # under ~/.ssh: the dedicated key for Eden's cloud machines
KEY_COMMENT = "eden-cloud"
USER = "eden"
READY_FILE = "/var/lib/eden/ready"  # the first-boot script's last step
HOURS_PER_MONTH = 730.0
PRICES_CHECKED = "October 2026"
# A machine's name: lower-case, starting with a letter (the strictest of the providers, Google
# Cloud's), and an SSH alias JARVIS's hand-off accepts.
NAME = re.compile(r"^[a-z][a-z0-9-]{1,38}[a-z0-9]$")
# A region or zone, a size, an image: nothing a shell or a CLI's own flags could take for
# something else (no spaces, no leading dash).
TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$")
PUBKEY = re.compile(r"^ssh-ed25519 [A-Za-z0-9+/=]{40,200}( [A-Za-z0-9._@-]{0,64})?$")
IPV4 = re.compile(r"\b((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})\b")
PLACEHOLDER = re.compile(
    r"\{(alias|region|size|image|bootstrap|pubkey_file|key_fingerprint|ip|id|port|sg|name|volume)\}"
)


@dataclass(frozen=True)
class Size:
    id: str
    label: str  # what it is, in the owner's words
    hourly: float  # USD an hour while it runs (the server, its public address)
    args: tuple[str, ...] = ()  # extra flags the create command takes for it


@dataclass
class Step:
    """One command of a plan. argv may hold {placeholders}: filled from what the earlier
    steps captured (the instance's id, its address) when it runs; the plan shows them as
    <id>, <ip>."""

    label: str
    argv: list[str]
    capture: str = ""  # "name:how": how is ipv4 | text | json:a.0.b | regex:<pattern> | words:a,b
    ok_if: str = ""  # a failure whose output matches this is fine ("already exists")
    timeout: float = 300.0
    stdin_file: str = ""  # a placeholder or path whose file is the command's stdin
    spawn: bool = False  # started and left running (tart run): never waited for

    def shown(self) -> str:
        return (
            "$ "
            + " ".join(
                PLACEHOLDER.sub(lambda m: f"<{m.group(1)}>", shlex.quote(a)) for a in self.argv
            )
            + (
                " < " + PLACEHOLDER.sub(lambda m: f"<{m.group(1)}>", self.stdin_file)
                if self.stdin_file
                else ""
            )
        )


@dataclass(frozen=True)
class Provider:
    id: str
    name: str
    clis: tuple[str, ...]  # the CLI's names, the first found is used
    install: str  # how to get the CLI
    login: str  # how to sign it in (the owner's own account)
    signed_in: tuple[str, ...]  # a command that succeeds (with output) once it's signed in
    region: str  # the default region or zone
    region_label: str
    sizes: tuple[Size, ...]
    base_image: str
    disk_gb: int
    disk_monthly: float  # USD a month for the disk (and what else stays while it's off)
    bills_when_off: bool  # a powered-off server still costs its full price
    local: bool = False  # runs on this Mac
    images: bool = True  # can save a warm image
    pricing_url: str = ""
    notes: tuple[str, ...] = ()

    def size(self, size_id: str) -> Size | None:
        return next((s for s in self.sizes if s.id == size_id), None)

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "cli": self.clis[0],
            "install": self.install,
            "login": self.login,
            "region": self.region,
            "region_label": self.region_label,
            "sizes": [{"id": s.id, "label": s.label, "hourly": s.hourly} for s in self.sizes],
            "local": self.local,
            "images": self.images,
            "bills_when_off": self.bills_when_off,
            "pricing_url": self.pricing_url,
            "notes": list(self.notes),
        }


PROVIDERS: dict[str, Provider] = {
    p.id: p
    for p in (
        Provider(
            "gcp", "Google Cloud", ("gcloud",),
            "brew install --cask google-cloud-sdk",
            "gcloud auth login, then gcloud config set project <your project>",
            ("gcloud", "config", "get-value", "account"),
            "us-central1-a", "Zone",
            (
                Size("e2-small", "2 shared vCPU, 2 GB", 0.0218),
                Size("e2-medium", "2 shared vCPU, 4 GB", 0.0385),
                Size("e2-standard-2", "2 vCPU, 8 GB", 0.0720),
            ),
            "debian-12", 20, 2.00, False,
            pricing_url="cloud.google.com/compute/vm-instance-pricing",
            notes=("Uses the project your gcloud is set to (gcloud config get-value project).",),
        ),
        Provider(
            "aws", "AWS EC2", ("aws",),
            "brew install awscli",
            "aws configure (or aws sso login), with a default region",
            ("aws", "sts", "get-caller-identity", "--output", "json"),
            "us-east-1", "Region",
            (
                Size("t3.small", "2 vCPU, 2 GB", 0.0258),
                Size("t3.medium", "2 vCPU, 4 GB", 0.0466),
                Size("t3.large", "2 vCPU, 8 GB", 0.0882),
            ),
            "resolve:ssm:/aws/service/debian/release/12/latest/amd64", 20, 1.60, False,
            pricing_url="aws.amazon.com/ec2/pricing/on-demand",
            notes=(
                "Opens SSH (port 22, key only) in a security group of its own, eden-cloud-ssh, "
                "in the region's default VPC.",
                "A check runs the create with --dry-run first: your permissions and limits, "
                "nothing made.",
            ),
        ),
        Provider(
            "hetzner", "Hetzner Cloud", ("hcloud",),
            "brew install hcloud",
            "hcloud context create eden (paste an API token from the Hetzner console)",
            ("hcloud", "context", "active"),
            "fsn1", "Location",
            (
                Size("cx22", "2 vCPU, 4 GB", 0.0072),
                Size("cx32", "4 vCPU, 8 GB", 0.0122),
                Size("cx42", "8 vCPU, 16 GB", 0.0290),
            ),
            "debian-12", 40, 0.0, True,
            pricing_url="hetzner.com/cloud",
            notes=(
                "Hetzner bills a server while it's off. To cap cost, set idle machines to be "
                "deleted (Settings below); save a warm image first so the next starts warm.",
                "Billed at most the monthly price, whatever the hours.",
            ),
        ),
        Provider(
            "do", "DigitalOcean", ("doctl",),
            "brew install doctl",
            "doctl auth init (paste an API token from the DigitalOcean console)",
            ("doctl", "account", "get"),
            "nyc3", "Region",
            (
                Size("s-1vcpu-2gb", "1 vCPU, 2 GB", 0.0179),
                Size("s-2vcpu-4gb", "2 vCPU, 4 GB", 0.0357),
                Size("s-4vcpu-8gb", "4 vCPU, 8 GB", 0.0714),
            ),
            "debian-12-x64", 50, 0.0, True,
            pricing_url="digitalocean.com/pricing/droplets",
            notes=(
                "DigitalOcean bills a Droplet while it's off. To cap cost, set idle machines "
                "to be deleted (Settings below); save a warm image first.",
            ),
        ),
        Provider(
            "fly", "Fly.io Machines", ("flyctl", "fly"),
            "brew install flyctl",
            "flyctl auth login",
            ("flyctl", "auth", "whoami"),
            "iad", "Region",
            (
                Size("shared-cpu-2x", "2 shared vCPU, 2 GB", 0.0156, ("--vm-memory", "2048")),
                Size("performance-1x", "1 vCPU, 2 GB", 0.0431),
                Size("performance-2x", "2 vCPU, 4 GB", 0.0861),
            ),
            "debian:12", 10, 4.30, False, images=False,
            pricing_url="fly.io/docs/about/pricing",
            notes=(
                "An app of its own with a 10 GB volume for /home (kept while it's stopped) and "
                "a dedicated IPv4 address ($2 a month) for SSH.",
                "Its home volume stays between runs, so it's already warm: no image needed.",
            ),
        ),
        Provider(
            "docker", "Docker or OrbStack (this Mac)", ("docker",),
            "Install OrbStack (orbstack.dev) or Docker Desktop",
            "Start OrbStack or Docker Desktop",
            ("docker", "info", "--format", "{{.ServerVersion}}"),
            "local", "Where", (Size("local", "As much as Docker is given", 0.0),),
            "debian:12", 0, 0.0, False, local=True,
            notes=(
                "Runs on this Mac, so it stops when the Mac sleeps: a private rehearsal, or a "
                "Mac that stays on. Free.",
            ),
        ),
        Provider(
            "tart", "Tart VM (this Mac)", ("tart",),
            "brew install cirruslabs/cli/tart",
            "Nothing to sign in to",
            ("tart", "--version"),
            "local", "Where",
            (
                Size("2cpu-4gb", "2 vCPU, 4 GB", 0.0, ("2", "4096")),
                Size("4cpu-8gb", "4 vCPU, 8 GB", 0.0, ("4", "8192")),
            ),
            "ghcr.io/cirruslabs/ubuntu:latest", 0, 0.0, False, local=True,
            notes=(
                "A Linux VM on this Mac (Apple silicon), so it stops when the Mac sleeps. Free "
                "for personal use (Tart's licence asks larger companies to pay).",
                "Needs Tart 2.22 or later (tart exec).",
            ),
        ),
    )
}  # fmt: skip


# ── the cost estimate ──


def estimate(
    provider: Provider, size: Size, idle_minutes: int, hours_a_day: float = 4.0
) -> dict[str, Any]:
    """What it would cost, as a range the owner can weigh: an hour, a typical month of some
    hours a day (the watchdog stops it otherwise), and a month left on. Never a promise."""
    hourly = size.hourly
    stopped = provider.disk_monthly
    if provider.bills_when_off:
        typical = left_on = hourly * HOURS_PER_MONTH  # (billed whether it's on or off)
    else:
        typical = hourly * hours_a_day * 30 + stopped
        left_on = hourly * HOURS_PER_MONTH + stopped
    if provider.local:
        lines = ["Free: it runs on this Mac."]
    else:
        lines = [
            f"About ${hourly:.3f} an hour while it runs ({size.id}, {size.label}).",
            (
                f"About ${left_on:.2f} a month, on or off (the provider bills it while it's off)."
                if provider.bills_when_off
                else f"About ${typical:.2f} a month at {hours_a_day:g} hours a day; "
                f"${left_on:.2f} if it never stopped; ${stopped:.2f} a month while stopped (disk)."
            ),
            (
                f"Stops itself after {idle_minutes} minutes idle."
                if idle_minutes and not provider.bills_when_off
                else "Not stopped when idle (it would be billed anyway): delete it when idle "
                "to cap cost."
                if provider.bills_when_off
                else "Idle stop is off: it runs until you stop it."
            ),
            f"An estimate from list prices ({PRICES_CHECKED}); check {provider.pricing_url}.",
        ]
    return {
        "hourly": round(hourly, 4),
        "typical_month": round(typical, 2),
        "left_on_month": round(left_on, 2),
        "stopped_month": round(stopped, 2),
        "lines": lines,
    }


# ── the first-boot script ──


WATCHDOG = r"""#!/bin/sh
# Eden Code idle stop: after IDLE_MINUTES with no Claude Code run and nobody connected,
# this machine stops itself, so a forgotten one stops costing compute.
IDLE_MINUTES=__IDLE__
[ "$IDLE_MINUTES" -gt 0 ] 2>/dev/null || exit 0
STATE=/var/lib/eden/last-busy
busy() {
  pgrep -u eden -f claude >/dev/null 2>&1 && return 0
  [ -n "$(who 2>/dev/null)" ] && return 0
  if command -v ss >/dev/null 2>&1; then
    [ -n "$(ss -Htn state established '( sport = :22 )' 2>/dev/null)" ] && return 0
  fi
  return 1
}
now=$(date +%s)
if busy || [ ! -s "$STATE" ]; then echo "$now" > "$STATE"; exit 0; fi
last=$(cat "$STATE")
[ $((now - last)) -ge $((IDLE_MINUTES * 60)) ] || exit 0
echo "$now" > "$STATE"
logger -t eden-idle "idle for $IDLE_MINUTES minutes: stopping" 2>/dev/null || true
__ACTION__
"""


def bootstrap(pubkey: str, idle_minutes: int, mode: str = "vm") -> str:
    """The first-boot script (run as root): user, key, tools, Claude Code, idle watchdog.
    Idempotent (Google Cloud runs it at every boot). mode "vm" (systemd timer) or
    "container" (it's the container's main process: sshd, then the watchdog's loop; idle,
    it ends, and the container or Fly Machine stops)."""
    pubkey = " ".join(str(pubkey).split())
    if not PUBKEY.match(pubkey):
        raise ValueError("not an ed25519 public key")
    idle = max(0, int(idle_minutes))
    container = mode == "container"
    action = "kill -TERM 1" if container else "/sbin/poweroff || shutdown -h now"
    watchdog = WATCHDOG.replace("__IDLE__", str(idle)).replace("__ACTION__", action)
    lines = [
        "#!/bin/sh",
        "# Eden Code cloud machine: first-boot setup, made by Eden Code. Runs as root; safe",
        "# to run again. A user 'eden' only your Eden key gets into, git, tmux, Claude Code,",
        "# and the idle stop.",
        "set -eu",
        "export DEBIAN_FRONTEND=noninteractive",
        "mkdir -p /var/lib/eden",
        "rm -f " + READY_FILE,
        "if ! command -v git >/dev/null 2>&1 || ! command -v tmux >/dev/null 2>&1 || "
        "[ ! -x /usr/sbin/sshd ]; then",
        "  apt-get update -q",
        "  apt-get install -yq --no-install-recommends git tmux curl ca-certificates sudo "
        "openssh-server procps iproute2",
        "fi",
        f"id {USER} >/dev/null 2>&1 || useradd -m -s /bin/bash {USER}",
        f"install -d -m 700 -o {USER} -g {USER} /home/{USER}/.ssh",
        f"printf '%s\\n' '{pubkey}' > /home/{USER}/.ssh/authorized_keys",
        f"chown {USER}:{USER} /home/{USER}/.ssh/authorized_keys",
        f"chmod 600 /home/{USER}/.ssh/authorized_keys",
        f"echo '{USER} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/{USER}",
        f"chmod 440 /etc/sudoers.d/{USER}",
        f"if [ ! -x /home/{USER}/.local/bin/claude ]; then",
        f"  su - {USER} -c 'curl -fsSL https://claude.ai/install.sh | bash' || true",
        "fi",
        "cat > /usr/local/bin/eden-idle <<'EDEN_IDLE'",
        watchdog.rstrip("\n"),
        "EDEN_IDLE",
        "chmod 755 /usr/local/bin/eden-idle",
        "date +%s > /var/lib/eden/last-busy",
    ]
    if container:
        lines += [
            "ssh-keygen -A",
            "mkdir -p /run/sshd",
            "touch " + READY_FILE,
            "trap 'exit 0' TERM INT",
            "/usr/sbin/sshd -e",
            "while :; do sleep 60 & wait $!; /usr/local/bin/eden-idle || true; done",
        ]
    else:
        lines += [
            "cat > /etc/systemd/system/eden-idle.service <<'EOF'",
            "[Unit]",
            "Description=Eden Code idle stop",
            "[Service]",
            "Type=oneshot",
            "ExecStart=/usr/local/bin/eden-idle",
            "EOF",
            "cat > /etc/systemd/system/eden-idle.timer <<'EOF'",
            "[Unit]",
            "Description=Eden Code idle stop, every minute",
            "[Timer]",
            "OnBootSec=5min",
            "OnUnitActiveSec=1min",
            "[Install]",
            "WantedBy=timers.target",
            "EOF",
            "systemctl daemon-reload",
            "systemctl enable --now eden-idle.timer",
            "systemctl enable --now ssh 2>/dev/null || systemctl enable --now sshd 2>/dev/null || true",
            "touch " + READY_FILE,
        ]
    return "\n".join(lines) + "\n"


def do_fingerprint(pubkey: str) -> str:
    """DigitalOcean names an SSH key by its MD5 fingerprint (aa:bb:…)."""
    blob = base64.b64decode(pubkey.split()[1])
    digest = hashlib.md5(blob, usedforsecurity=False).hexdigest()
    return ":".join(digest[i : i + 2] for i in range(0, len(digest), 2))


# ── the plans ──


@dataclass
class Spec:
    """What the owner chose: where, how big, from which image (a warm one, or the base)."""

    provider: str
    alias: str
    region: str
    size: str
    image: str = ""  # a warm image (its id or name), else the provider's base
    port: int = 0  # docker: the Mac's port for its SSH
    extra: dict[str, str] = field(default_factory=dict)


def check(spec: Spec, provider: Provider) -> str:
    """Why the choice can't be planned ("" when it can)."""
    if not NAME.match(spec.alias):
        return "A name is 3 to 40 lower-case letters, digits and dashes, starting with a letter."
    if not TOKEN.match(spec.region or ""):
        return f"That isn't a {provider.region_label.lower()}."
    if provider.size(spec.size) is None:
        return "Pick one of the sizes listed."
    if spec.image and not TOKEN.match(spec.image):
        return "That isn't an image name."
    if provider.id == "docker" and not 1024 < spec.port < 65536:
        return "No free port for its SSH."
    return ""


def create_steps(spec: Spec, provider: Provider) -> list[Step]:
    """The provider's commands that make the machine, ending with its address captured
    (ip) and, where it has one, its id (id)."""
    a, r, size = spec.alias, spec.region, provider.size(spec.size)
    assert size is not None
    image = spec.image or provider.base_image
    p = provider.id
    if p == "gcp":
        source = (
            ["--image", image]
            if spec.image
            else ["--image-family", "debian-12", "--image-project", "debian-cloud"]
        )
        return [
            Step("Make the server", [
                "gcloud", "compute", "instances", "create", a, "--zone", r, "--machine-type",
                size.id, *source, f"--boot-disk-size={provider.disk_gb}GB",
                "--metadata-from-file", "startup-script={bootstrap}", "--labels", "eden-cloud=1",
                "--format", "json", "--quiet",
            ], timeout=600),
            Step("Read its address", [
                "gcloud", "compute", "instances", "describe", a, "--zone", r, "--format",
                "value(networkInterfaces[0].accessConfigs[0].natIP)",
            ], capture="ip:ipv4"),
        ]  # fmt: skip
    if p == "aws":
        return [
            Step("Make a security group for SSH (once)", [
                "aws", "ec2", "create-security-group", "--region", r, "--group-name",
                "eden-cloud-ssh", "--description", "Eden Code cloud machines: SSH in, key only",
                "--output", "text", "--query", "GroupId",
            ], ok_if="InvalidGroup.Duplicate"),
            Step("Find the security group", [
                "aws", "ec2", "describe-security-groups", "--region", r, "--group-names",
                "eden-cloud-ssh", "--query", "SecurityGroups[0].GroupId", "--output", "text",
            ], capture="sg:text"),
            Step("Let SSH in (once)", [
                "aws", "ec2", "authorize-security-group-ingress", "--region", r, "--group-id",
                "{sg}", "--protocol", "tcp", "--port", "22", "--cidr", "0.0.0.0/0",
            ], ok_if="InvalidPermission.Duplicate"),
            Step("Make the server", [
                "aws", "ec2", "run-instances", "--region", r, "--image-id", image,
                "--instance-type", size.id, "--security-group-ids", "{sg}", "--user-data",
                "file://{bootstrap}", "--instance-initiated-shutdown-behavior", "stop",
                "--block-device-mappings",
                f"DeviceName=/dev/xvda,Ebs={{VolumeSize={provider.disk_gb},VolumeType=gp3}}",
                "--tag-specifications",
                f"ResourceType=instance,Tags=[{{Key=Name,Value={a}}},{{Key=eden-cloud,Value=1}}]",
                "--output", "json",
            ], capture="id:json:Instances.0.InstanceId", timeout=600),
            Step("Wait for it to run", [
                "aws", "ec2", "wait", "instance-running", "--region", r, "--instance-ids", "{id}",
            ], timeout=600),
            Step("Read its address", [
                "aws", "ec2", "describe-instances", "--region", r, "--instance-ids", "{id}",
                "--query", "Reservations[0].Instances[0].PublicIpAddress", "--output", "text",
            ], capture="ip:ipv4"),
        ]  # fmt: skip
    if p == "hetzner":
        return [
            Step("Add your Eden key to Hetzner (once)", [
                "hcloud", "ssh-key", "create", "--name", KEY_COMMENT, "--public-key-from-file",
                "{pubkey_file}",
            ], ok_if="uniqueness_error|already"),
            Step("Make the server", [
                "hcloud", "server", "create", "--name", a, "--type", size.id, "--image", image,
                "--location", r, "--ssh-key", KEY_COMMENT, "--user-data-from-file",
                "{bootstrap}", "--label", "eden-cloud=1", "-o", "json",
            ], capture="id:json:server.id", timeout=600),
            Step("Read its address", ["hcloud", "server", "ip", a], capture="ip:ipv4"),
        ]  # fmt: skip
    if p == "do":
        return [
            Step("Add your Eden key to DigitalOcean (once)", [
                "doctl", "compute", "ssh-key", "import", KEY_COMMENT, "--public-key-file",
                "{pubkey_file}",
            ], ok_if="already|422"),
            Step("Make the Droplet", [
                "doctl", "compute", "droplet", "create", a, "--size", size.id, "--image", image,
                "--region", r, "--ssh-keys", "{key_fingerprint}", "--user-data-file",
                "{bootstrap}", "--tag-name", "eden-cloud", "--wait", "--format",
                "ID,PublicIPv4", "--no-header",
            ], capture="id,ip:words", timeout=600),
        ]  # fmt: skip
    if p == "fly":
        return [
            Step("Make an app for it", ["flyctl", "apps", "create", a, "--org", "personal"],
                 ok_if="already"),
            Step("Make its home volume (10 GB)", [
                "flyctl", "volumes", "create", "eden_home", "--app", a, "--region", r,
                "--size", str(provider.disk_gb), "--yes",
            ]),
            Step("Give it an IPv4 address for SSH", [
                "flyctl", "ips", "allocate-v4", "--app", a, "--yes",
            ], capture="ip:ipv4"),
            Step("Start the Machine", [
                "flyctl", "machine", "run", image, "--app", a, "--region", r, "--vm-size",
                size.id, *size.args, "--volume", "eden_home:/home", "--file-local",
                "/eden/bootstrap.sh={bootstrap}", "--entrypoint", "/bin/sh /eden/bootstrap.sh",
                "--port", "22:22/tcp", "--autostop=off", "--autostart=true", "--restart", "no",
                "--detach",
            ], capture=r"id:regex:(?i)machine\s+(?:id:?\s*)?([0-9a-f]{10,})", timeout=600),
        ]  # fmt: skip
    if p == "docker":
        volume = f"{a}-home"
        return [
            Step("Make its home volume", ["docker", "volume", "create", volume]),
            Step("Start the container", [
                "docker", "run", "-d", "--name", a, "--hostname", a, "-p",
                "127.0.0.1:{port}:22", "-v", f"{volume}:/home", "-v",
                "{bootstrap}:/eden/bootstrap.sh:ro", "--label", "eden-cloud=1", "--restart",
                "no", image, "/bin/sh", "/eden/bootstrap.sh",
            ], capture="id:text", timeout=900),
        ]  # fmt: skip
    if p == "tart":
        cpu, memory = size.args
        return [
            Step("Copy the VM image", ["tart", "clone", image, a], timeout=1800),
            Step("Size it", ["tart", "set", a, "--cpu", cpu, "--memory", memory]),
            Step("Start it (in the background)", ["tart", "run", a, "--no-graphics"], spawn=True),
            Step("Read its address", ["tart", "ip", a, "--wait", "180"], capture="ip:ipv4",
                 timeout=240),
            Step("Run the first-boot setup in it", [
                "tart", "exec", "-i", a, "sudo", "sh", "-s",
            ], stdin_file="{bootstrap}", timeout=900),
        ]  # fmt: skip
    raise ValueError(p)


def ssh_target(spec: Spec, provider: Provider, ip: str) -> dict[str, Any]:
    """How the Mac's ssh reaches it: the machine's address, or this Mac's port for a local
    container."""
    if provider.id == "docker":
        return {"host": "127.0.0.1", "port": spec.port, "user": USER}
    return {"host": ip, "port": 22, "user": USER}


def _id_or_name(rec: dict[str, Any]) -> str:
    return str(rec.get("id") or rec.get("alias") or "")


def status_step(rec: dict[str, Any]) -> Step:
    """The command that says whether it runs (parse_status reads its output)."""
    p, a, r, ident = rec["provider"], rec["alias"], rec.get("region", ""), _id_or_name(rec)
    argv = {
        "gcp": ["gcloud", "compute", "instances", "describe", a, "--zone", r, "--format", "value(status)"],
        "aws": ["aws", "ec2", "describe-instances", "--region", r, "--instance-ids", ident, "--query",
                "Reservations[0].Instances[0].State.Name", "--output", "text"],
        "hetzner": ["hcloud", "server", "describe", a, "-o", "format={{.Status}}"],
        "do": ["doctl", "compute", "droplet", "get", ident, "--format", "Status", "--no-header"],
        "fly": ["flyctl", "machine", "status", ident, "--app", a],
        "docker": ["docker", "inspect", "-f", "{{.State.Status}}", a],
        "tart": ["tart", "list", "--format", "json"],
    }[p]  # fmt: skip
    return Step("Ask whether it runs", argv, timeout=60)


def parse_status(provider: str, code: int, out: str, err: str = "", alias: str = "") -> str:
    """running | stopped | gone | "" (couldn't tell), from status_step's result."""
    text = (out or "").strip().lower()
    if code != 0:
        if re.search(
            r"not ?found|does not exist|no such|invalid.*id|404|was not found", (err + out).lower()
        ):
            return "gone"
        return ""
    if provider == "tart":
        import json

        try:
            rows = json.loads(out or "[]")
        except ValueError:
            return ""
        row = next((x for x in rows if isinstance(x, dict) and x.get("Name") == alias), None)
        if row is None:
            return "gone"
        text = str(row.get("State") or "").lower()
    if provider == "fly":
        m = re.search(r"state:\s*(\w+)", text)
        text = m.group(1) if m else text
    if provider == "aws" and text in ("terminated", "shutting-down"):
        return "gone"  # (EC2's terminated is deleted; Google Cloud's TERMINATED is stopped)
    if text in ("running", "active", "started", "starting", "pending", "staging", "provisioning"):
        return "running"
    if text in ("terminated", "stopped", "stopping", "off", "exited", "created", "suspended",
                "suspending"):  # fmt: skip
        return "stopped"
    if text in ("destroyed", "destroying", "deleted"):
        return "gone"
    return ""


def stop_steps(rec: dict[str, Any]) -> list[Step]:
    p, a, r, ident = rec["provider"], rec["alias"], rec.get("region", ""), _id_or_name(rec)
    return [{
        "gcp": Step("Stop it", ["gcloud", "compute", "instances", "stop", a, "--zone", r, "--quiet"]),
        "aws": Step("Stop it", ["aws", "ec2", "stop-instances", "--region", r, "--instance-ids", ident]),
        "hetzner": Step("Shut it down", ["hcloud", "server", "shutdown", a]),
        "do": Step("Power it off", ["doctl", "compute", "droplet-action", "power-off", ident, "--wait"]),
        "fly": Step("Stop the Machine", ["flyctl", "machine", "stop", ident, "--app", a]),
        "docker": Step("Stop the container", ["docker", "stop", a]),
        "tart": Step("Stop the VM", ["tart", "stop", a]),
    }[p]]  # fmt: skip


def start_steps(rec: dict[str, Any]) -> list[Step]:
    """Start it again, ending with its address read again (a stopped server's public address
    can change: Google Cloud's and EC2's ephemeral ones do)."""
    p, a, r, ident = rec["provider"], rec["alias"], rec.get("region", ""), _id_or_name(rec)
    steps = {
        "gcp": [
            Step("Start it", ["gcloud", "compute", "instances", "start", a, "--zone", r, "--quiet"], timeout=300),
            Step("Read its address", ["gcloud", "compute", "instances", "describe", a, "--zone", r,
                 "--format", "value(networkInterfaces[0].accessConfigs[0].natIP)"], capture="ip:ipv4"),
        ],
        "aws": [
            Step("Start it", ["aws", "ec2", "start-instances", "--region", r, "--instance-ids", ident]),
            Step("Wait for it to run", ["aws", "ec2", "wait", "instance-running", "--region", r,
                 "--instance-ids", ident], timeout=600),
            Step("Read its address", ["aws", "ec2", "describe-instances", "--region", r,
                 "--instance-ids", ident, "--query", "Reservations[0].Instances[0].PublicIpAddress",
                 "--output", "text"], capture="ip:ipv4"),
        ],
        "hetzner": [
            Step("Power it on", ["hcloud", "server", "poweron", a]),
            Step("Read its address", ["hcloud", "server", "ip", a], capture="ip:ipv4"),
        ],
        "do": [Step("Power it on", ["doctl", "compute", "droplet-action", "power-on", ident, "--wait"])],
        "fly": [Step("Start the Machine", ["flyctl", "machine", "start", ident, "--app", a])],
        "docker": [Step("Start the container", ["docker", "start", a])],
        "tart": [
            Step("Start it (in the background)", ["tart", "run", a, "--no-graphics"], spawn=True),
            Step("Read its address", ["tart", "ip", a, "--wait", "180"], capture="ip:ipv4", timeout=240),
        ],
    }  # fmt: skip
    return steps[p]


def delete_steps(rec: dict[str, Any]) -> list[Step]:
    """Everything the plan made for it, deleted (the shared, free bits stay: the SSH key
    entry at the provider, AWS's security group)."""
    p, a, r, ident = rec["provider"], rec["alias"], rec.get("region", ""), _id_or_name(rec)
    steps = {
        "gcp": [Step("Delete the server and its disk", ["gcloud", "compute", "instances", "delete", a,
                "--zone", r, "--quiet"], timeout=600)],
        "aws": [Step("Terminate the server (its disk goes with it)", ["aws", "ec2",
                "terminate-instances", "--region", r, "--instance-ids", ident])],
        "hetzner": [Step("Delete the server", ["hcloud", "server", "delete", a])],
        "do": [Step("Delete the Droplet", ["doctl", "compute", "droplet", "delete", ident, "--force"])],
        "fly": [Step("Delete the app, its Machine, volume and address", ["flyctl", "apps", "destroy",
                a, "--yes"])],
        "docker": [
            Step("Remove the container", ["docker", "rm", "-f", a]),
            Step("Remove its home volume", ["docker", "volume", "rm", f"{a}-home"], ok_if="no such"),
        ],
        "tart": [
            Step("Stop the VM", ["tart", "stop", a], ok_if="not running|stopped"),
            Step("Delete the VM", ["tart", "delete", a]),
        ],
    }  # fmt: skip
    return steps[p]


def image_name(project: str, provider: str) -> str:
    """A warm image's name: eden-<project>-<provider>, as every provider takes one."""
    slug = re.sub(r"[^a-z0-9]+", "-", str(project).lower()).strip("-")[:30] or "project"
    if not slug[0].isalpha():
        slug = "p-" + slug
    return f"eden-{slug}-{provider}"


def image_steps(rec: dict[str, Any], name: str) -> list[Step]:
    """Save the machine as a warm image (capture "image": what a new machine starts from).
    The disk is imaged with the machine stopped where the provider needs it, then started."""
    p, a, r, ident = rec["provider"], rec["alias"], rec.get("region", ""), _id_or_name(rec)
    if p == "gcp":
        return [
            *stop_steps(rec),
            Step("Save its disk as an image", ["gcloud", "compute", "images", "create", name,
                 "--source-disk", a, "--source-disk-zone", r, "--labels", "eden-cloud=1",
                 "--force", "--quiet"], timeout=1200),
            Step("Name the image", ["echo", name], capture="image:text"),
        ]  # fmt: skip
    if p == "aws":
        return [Step("Save it as an AMI", ["aws", "ec2", "create-image", "--region", r,
                "--instance-id", ident, "--name", name, "--output", "text", "--query", "ImageId"],
                capture="image:text", timeout=600)]  # fmt: skip
    if p == "hetzner":
        return [Step("Save a snapshot", ["hcloud", "server", "create-image", "--type", "snapshot",
                "--description", name, a, "-o", "json"], capture="image:json:image.id",
                timeout=1800)]  # fmt: skip
    if p == "do":
        return [
            *stop_steps(rec),
            Step("Save a snapshot", ["doctl", "compute", "droplet-action", "snapshot", ident,
                 "--snapshot-name", name, "--wait"], timeout=1800),
            Step("Find the snapshot", ["doctl", "compute", "snapshot", "list", name, "--format",
                 "ID", "--no-header"], capture="image:text"),
        ]  # fmt: skip
    if p == "docker":
        tag = f"eden-warm/{name}:latest"
        return [
            Step("Save the container as an image", ["docker", "commit", a, tag], timeout=900),
            Step("Name the image", ["echo", tag], capture="image:text"),
        ]
    if p == "tart":
        return [
            *stop_steps(rec),
            Step("Copy the VM as the warm image", ["tart", "clone", a, name], timeout=1800),
            Step("Name the image", ["echo", name], capture="image:text"),
        ]
    raise ValueError(f"{p} keeps no images")


def image_delete_steps(env: dict[str, Any]) -> list[Step]:
    p, img, r = env["provider"], str(env["image"]), env.get("region", "")
    return [{
        "gcp": Step("Delete the image", ["gcloud", "compute", "images", "delete", img, "--quiet"]),
        "aws": Step("Deregister the AMI", ["aws", "ec2", "deregister-image", "--region", r,
                    "--image-id", img]),
        "hetzner": Step("Delete the snapshot", ["hcloud", "image", "delete", img]),
        "do": Step("Delete the snapshot", ["doctl", "compute", "snapshot", "delete", img, "--force"]),
        "docker": Step("Delete the image", ["docker", "image", "rm", img]),
        "tart": Step("Delete the VM image", ["tart", "delete", img]),
    }[p]]  # fmt: skip


def dry_run_step(spec: Spec, provider: Provider) -> Step | None:
    """A check that makes nothing: AWS's --dry-run (permissions and limits). The others have
    none; their plan is only shown."""
    if provider.id != "aws":
        return None
    return Step("Check permissions and limits (--dry-run: makes nothing)", [
        "aws", "ec2", "run-instances", "--dry-run", "--region", spec.region, "--image-id",
        spec.image or provider.base_image, "--instance-type", spec.size, "--count", "1",
    ], ok_if="DryRunOperation", timeout=60)  # fmt: skip


# ── reading what came back ──


def capture(how: str, out: str) -> dict[str, str]:
    """The values a step's capture names, from its output ({} when they aren't there)."""
    names, _, kind = how.partition(":")
    out = out or ""
    if kind == "ipv4":
        m = IPV4.search(out)
        return {names: m.group(1)} if m else {}
    if kind == "text":
        line = next((x.strip() for x in out.splitlines() if x.strip()), "")
        return {names: line} if line and line.lower() != "none" else {}
    if kind == "words":
        parts = out.split()
        keys = names.split(",")
        return dict(zip(keys, parts, strict=False)) if len(parts) >= len(keys) else {}
    if kind.startswith("json:"):
        import json

        try:
            value: Any = json.loads(out)
        except ValueError:
            return {}
        for part in kind[5:].split("."):
            if isinstance(value, list) and part.isdigit() and int(part) < len(value):
                value = value[int(part)]
            elif isinstance(value, dict) and part in value:
                value = value[part]
            else:
                return {}
        return {names: str(value)} if isinstance(value, str | int) else {}
    if kind.startswith("regex:"):
        m = re.search(kind[6:], out)
        return {names: m.group(1)} if m else {}
    return {}


def fill(argv: list[str], values: dict[str, str]) -> list[str] | None:
    """argv with its {placeholders} filled; None when one has no value yet."""
    missing = False

    def sub(m: re.Match[str]) -> str:
        nonlocal missing
        value = values.get(m.group(1))
        if value is None or value == "":
            missing = True
            return m.group(0)
        return str(value)

    out = [PLACEHOLDER.sub(sub, a) for a in argv]
    return None if missing else out


def ssh_block(
    alias: str, target: dict[str, Any], key_path: str, known_hosts: str, provider: str
) -> str:
    """A Host block for ~/.ssh/eden-cloud.conf (Eden's own file, Included from the owner's
    ~/.ssh/config): their key, a known-hosts file of its own (a new machine's key is taken
    on first sight, then held to)."""
    host = str(target["host"])
    if not (IPV4.fullmatch(host) or host == "127.0.0.1") or not NAME.match(alias):
        raise ValueError("bad ssh target")
    lines = [
        f"# Eden Code cloud machine ({provider}). Eden rewrites this block; edit others freely.",
        f"Host {alias}",
        f"  HostName {host}",
        f"  User {target['user']}",
        f"  IdentityFile {key_path}",
        "  IdentitiesOnly yes",
        "  StrictHostKeyChecking accept-new",
        f"  UserKnownHostsFile {known_hosts}",
    ]
    if int(target.get("port") or 22) != 22:
        lines.insert(3, f"  Port {int(target['port'])}")
    return "\n".join(lines) + "\n"
