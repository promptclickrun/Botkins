# The StopWatch's `@botkins {"do":"frame"}` dump as a PNG (esp32/README.md, "The board's own console lines").
#
#   python3 frame_to_png.py <captured console text> <out.png> [byte offset to start reading at]
#
# Takes the last whole dump in the file. Log lines between its rows are skipped, and a row a log line
# landed inside repeats the row above it (the count is printed). Python 3, nothing else.
import sys, base64, struct, zlib
data = open(sys.argv[1], 'rb').read()[int(sys.argv[3]) if len(sys.argv) > 3 else 0:].decode('utf-8', 'replace').replace('\r', '')
lines = data.split('\n')
ends = [i for i, l in enumerate(lines) if '"frame":"end"' in l]
assert ends, 'no frame end'
end = ends[-1]
start = max(i for i, l in enumerate(lines[:end]) if '{"frame":{' in l)
import json
head = json.loads(lines[start][lines[start].index('{'):])['frame']
W, H = head['width'], head['height']
rows = {}
for l in lines[start + 1:end]:
    if not l.startswith('@frame '):
        continue
    # A log line can land inside a row (the port prints both); such a row is left out, not fatal.
    try:
        _, y, b = l.split(' ', 2)
        row = base64.b64decode(b.strip(), validate=True)
    except ValueError:
        continue
    if len(row) == W * 2:
        rows[int(y)] = row
missing = [y for y in range(H) if y not in rows]
raw = bytearray()
last = b'\0' * W * 2
for y in range(H):
    raw.append(0)
    # A row that didn't arrive whole repeats the one above, so it shows as a seam, not a black line.
    row = last = rows.get(y, last)
    for x in range(W):
        v = row[2 * x] << 8 | row[2 * x + 1]
        r, g, b = (v >> 11) & 31, (v >> 5) & 63, v & 31
        raw += bytes((r << 3 | r >> 2, g << 2 | g >> 4, b << 3 | b >> 2))
def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b'')
open(sys.argv[2], 'wb').write(png)
print(sys.argv[2], head.get('kind'), head.get('light'), 'missing rows:', len(missing))
