
import os
import ipaddress
from datetime import datetime, timedelta
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend

# 生成私钥
private_key = rsa.generate_private_key(
    public_exponent=65537,
    key_size=2048,
    backend=default_backend()
)

# 生成证书
subject = issuer = x509.Name([
    x509.NameAttribute(NameOID.COUNTRY_NAME, "CN"),
    x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, "State"),
    x509.NameAttribute(NameOID.LOCALITY_NAME, "City"),
    x509.NameAttribute(NameOID.ORGANIZATION_NAME, "故障检修系统"),
    x509.NameAttribute(NameOID.COMMON_NAME, "192.168.43.122"),
])

cert = x509.CertificateBuilder().subject_name(
    subject
).issuer_name(
    issuer
).public_key(
    private_key.public_key()
).serial_number(
    x509.random_serial_number()
).not_valid_before(
    datetime.now()
).not_valid_after(
    datetime.now() + timedelta(days=3650)
).add_extension(
    x509.SubjectAlternativeName([
        x509.DNSName("localhost"),
        x509.DNSName("192.168.43.122"),
        x509.IPAddress(ipaddress.IPv4Address("192.168.43.122")),
    ]),
    critical=False,
).sign(private_key, hashes.SHA256(), default_backend())

# 保存证书和私钥
os.makedirs(os.path.join(os.path.dirname(__file__), '..', 'ssl'), exist_ok=True)

key_path = os.path.join(os.path.dirname(__file__), '..', 'ssl', 'key.pem')
cert_path = os.path.join(os.path.dirname(__file__), '..', 'ssl', 'cert.pem')

with open(key_path, "wb") as f:
    f.write(private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption()
    ))

with open(cert_path, "wb") as f:
    f.write(cert.public_bytes(encoding=serialization.Encoding.PEM))

print(f"证书已生成:")
print(f"私钥: {key_path}")
print(f"证书: {cert_path}")

