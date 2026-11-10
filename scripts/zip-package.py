"""Package an explicit file list using Python's standard ZIP implementation."""
import base64
import io
import json
import sys
import zipfile

request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
if request["mode"] == "pack":
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as target:
        for name, encoded in request["entries"]:
            info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            target.writestr(info, base64.b64decode(encoded))
    sys.stdout.buffer.write(archive.getvalue())
elif request["mode"] == "inspect":
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(request["archive"]))) as archive:
        entries = [[name, base64.b64encode(archive.read(name)).decode("ascii")] for name in archive.namelist()]
    sys.stdout.buffer.write(json.dumps(entries, ensure_ascii=False).encode("utf-8"))
else:
    raise ValueError("Unknown ZIP operation")
