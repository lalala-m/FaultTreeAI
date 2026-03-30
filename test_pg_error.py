import socket, struct, re

s = socket.socket(2, 1)
s.settimeout(5)
s.connect(('127.0.0.1', 5432))
params = b'user\x00postgres\x00database\x00postgres\x00\x00'
s.sendall(struct.pack('!I', 4 + len(params)) + struct.pack('!I', 196608) + params)
data = b''
while True:
    try:
        d = s.recv(4096)
        if not d: break
        data += d
        if len(data) > 1000: break
    except: break
s.close()

# Parse with latin1 (passthrough for raw bytes)
raw = data.decode('latin1', errors='replace')
print('raw bytes:')
with open(r'd:\AllProject\FaultTreeAI\pg_error.txt', 'w', encoding='utf-8') as f:
    # Filter out non-printable and write hex
    hex_str = data.hex()
    f.write(f'hex: {hex_str}\n')
    f.write(f'repr: {repr(data)}\n')
    f.write(f'decoded latin1: {raw}\n')
    # Try to extract M field
    m = re.search(r'M(.+?)\x00', raw)
    if m:
        f.write(f'message: {m.group(1)}\n')
    c = re.search(r'C(.+?)\x00', raw)
    if c:
        f.write(f'code: {c.group(1)}\n')
print('done, wrote to pg_error.txt')
