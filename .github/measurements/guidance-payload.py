from collections import Counter
from pathlib import PurePosixPath
import json
import re
import sys
import tarfile

marker_path = "skills/.monke-restored.json"
roots = ("skills/imported", "skills/references/imported")
secret_names = {".ssh", ".env", ".netrc", ".npmrc", ".git", "id_rsa", "id_ed25519"}
counts = Counter()

with tarfile.open(sys.argv[1]) as archive:
    for member in archive:
        path = member.name
        assert path == marker_path or any(path == root or path.startswith(root + "/") for root in roots), path
        assert not PurePosixPath(path).is_absolute()
        assert not ({".."} | secret_names).intersection(PurePosixPath(path).parts), path
        assert member.isfile() or member.isdir(), path
        if member.isfile():
            counts["files"] += 1
            counts["bytes"] += member.size
            counts["executable"] += bool(member.mode & 0o111)
        else:
            counts["directories"] += 1
    marker = json.load(archive.extractfile(marker_path))
    for source, item in marker.items():
        assert set(item) == {"digest", "recipe", "tooling"}
        assert re.fullmatch(r"[0-9a-f]{64}", item["digest"])
        recipe = json.loads(item["recipe"])
        assert recipe["source"] == source
        assert re.fullmatch(r"[0-9a-f]{40}", recipe["commit"])
    counts["pinned recipes"] = len(marker)
assert counts["files"] > 1 and counts["pinned recipes"] > 0
print(dict(counts))
