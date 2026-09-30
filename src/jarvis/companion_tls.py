"""The phone companion's own certificate: HTTPS between the iPhone and this Mac.

Made here the first time the companion is switched on (an ECDSA P-256 key, self-signed),
kept beside prefs.json as one file readable by the owner alone, and kept until the owner
asks for a new one. There's no certificate authority to vouch for it, so the phone pins
it instead: its fingerprint (the SHA-256 of the certificate) travels in the pairing QR
code, and with a code typed by hand the phone and the Mac each show its first 16 hex
digits for the owner to compare.

A certificate lasts 820 days: Apple's platforms refuse TLS certificates valid for longer
than 825, even ones a person has chosen to trust. The app pins the fingerprint, so an old
one keeps working with it; Safari (the web page) warns once it has expired.
"""

from __future__ import annotations

import contextlib
import hashlib
import ipaddress
import logging
import os
import re
import secrets
import ssl
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

log = logging.getLogger("jarvis")

FILE_NAME = "companion-tls.pem"
VALID_DAYS = 820
_HEX = re.compile(r"[0-9a-f]{64}")


@dataclass(frozen=True)
class Identity:
    path: Path
    fingerprint: str  # lowercase hex SHA-256 of the certificate's DER bytes
    not_after: datetime  # UTC

    @property
    def short(self) -> str:
        return short_fingerprint(self.fingerprint)


def short_fingerprint(fingerprint: str) -> str:
    """The first 16 hex digits in four groups ("a1b2 c3d4 e5f6 0718"), to read aloud."""
    head = normalize(fingerprint)[:16]
    return " ".join(head[i : i + 4] for i in range(0, len(head), 4))


def normalize(fingerprint: str) -> str:
    """A fingerprint as given (any case, with colons or spaces) as bare lowercase hex."""
    return re.sub(r"[\s:]", "", str(fingerprint or "")).lower()[:200]


def matches(given: str, fingerprint: str) -> bool:
    """Whether a fingerprint a phone pinned is this one (compared in constant time)."""
    given = normalize(given)
    return bool(_HEX.fullmatch(given)) and secrets.compare_digest(given, normalize(fingerprint))


def fingerprint_of(der: bytes) -> str:
    return hashlib.sha256(der).hexdigest()


def load_or_create(
    folder: Path, hosts: list[str] | tuple[str, ...] = (), now: datetime | None = None
) -> Identity:
    """The certificate kept in folder, made first if there's none. One that can't be
    used (damaged, its key and certificate don't belong together) is kept aside and a new
    one made: paired phones then pair again. A file that's there but can't be read just
    now (its permissions) raises OSError and is left as it is. Blocking: run in a thread."""
    path = Path(folder) / FILE_NAME
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return create(folder, hosts, now)
    identity = _parse(path, raw)
    if identity is not None:
        with contextlib.suppress(OSError):
            if path.stat().st_mode & 0o077:
                path.chmod(0o600)  # the key is for the owner's eyes only
        return identity
    from . import jsonstore

    if jsonstore.set_aside(path) is None:
        raise OSError(f"{FILE_NAME} can't be used and couldn't be moved aside")
    log.warning("companion: the certificate couldn't be used; making a new one")
    return create(folder, hosts, now)


def create(
    folder: Path, hosts: list[str] | tuple[str, ...] = (), now: datetime | None = None
) -> Identity:
    """A new key and self-signed certificate, saved (replacing any before it)."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    now = now or datetime.now(UTC)
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, "J.A.R.V.I.S. companion"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "J.A.R.V.I.S."),
        ]
    )
    names: list[x509.GeneralName] = []
    for host in dict.fromkeys([*hosts, "localhost", "127.0.0.1"]):
        host = str(host).strip()
        if not host:
            continue
        try:
            names.append(x509.IPAddress(ipaddress.ip_address(host)))
        except ValueError:
            if re.fullmatch(r"[A-Za-z0-9.-]{1,253}", host):
                names.append(x509.DNSName(host))
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=VALID_DAYS))
        .add_extension(x509.SubjectAlternativeName(names), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ) + cert.public_bytes(serialization.Encoding.PEM)
    path = Path(folder) / FILE_NAME
    _write_private(path, pem)
    return Identity(
        path,
        fingerprint_of(cert.public_bytes(serialization.Encoding.DER)),
        cert.not_valid_after_utc,
    )


def _parse(path: Path, raw: bytes) -> Identity | None:
    """The identity in a saved file, or None when it can't be used."""
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    try:
        cert = x509.load_pem_x509_certificate(raw)
        key = serialization.load_pem_private_key(raw, password=None)
    except (ValueError, TypeError):
        return None
    if not isinstance(key, ec.EllipticCurvePrivateKey):
        return None
    pub = serialization.PublicFormat.SubjectPublicKeyInfo
    mine = key.public_key().public_bytes(serialization.Encoding.DER, pub)
    if cert.public_key().public_bytes(serialization.Encoding.DER, pub) != mine:
        return None  # a key and a certificate that don't belong together
    der = cert.public_bytes(serialization.Encoding.DER)
    return Identity(path, fingerprint_of(der), cert.not_valid_after_utc)


def _write_private(path: Path, data: bytes) -> None:
    """Written whole to a temp file made readable by the owner alone, then swapped in."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as out:
            os.fchmod(out.fileno(), 0o600)
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def remove(folder: Path) -> None:
    """Forget the certificate (the next start makes a new one)."""
    with contextlib.suppress(FileNotFoundError):
        (Path(folder) / FILE_NAME).unlink()


def server_context(identity: Identity) -> ssl.SSLContext:
    """TLS 1.2 or later, HTTP/1.1 only (what the companion server speaks)."""
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(str(identity.path))
    context.set_alpn_protocols(["http/1.1"])
    return context
