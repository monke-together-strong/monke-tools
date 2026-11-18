from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from pathlib import Path
from time import monotonic
import json
import os
import subprocess
import sys

checkout, pack_root, restore_root, mode = sys.argv[1:]
checkout, pack_root, restore_root = (Path(p).resolve() for p in (checkout, pack_root, restore_root))
sources_command = """
import { readRepoImportRecipeStore } from "./scripts/skill-import-recipes.ts";
import { describeSkillSource } from "./scripts/skill-lock.ts";
console.log(JSON.stringify(readRepoImportRecipeStore(process.cwd()).recipes.map(recipe => ({
  repository: describeSkillSource(recipe.source, process.cwd()).repository,
  commit: recipe.commit,
}))));
"""
recipes = json.loads(subprocess.check_output(["bun", "-e", sources_command], cwd=checkout))
pins = sorted({(recipe["repository"],recipe["commit"]) for recipe in recipes})
assert all(repository.startswith("https://github.com/") and commit for repository, commit in pins)
pack_root.mkdir(parents=True, exist_ok=True)
restore_root.mkdir(parents=True, exist_ok=True)
started = monotonic()

def seed(pin):
    repository, commit = pin
    key = sha256((repository + "\0" + commit).encode()).hexdigest()
    bare = restore_root / (key + ".git")
    subprocess.run(["git","init","--bare","--quiet","--template=",str(bare)], check=True)
    subprocess.run(["git","-C",str(bare),"-c","fetch.fsckObjects=true","fetch","--quiet","--no-tags","--depth","1","--",repository,commit], check=True)
    with (pack_root / (key + ".pack")).open("wb") as archive:
        subprocess.run(["git","-C",str(bare),"pack-objects","--stdout","--revs"], input=(commit+"\n").encode(),stdout=archive,check=True)

def validate(pin):
    repository, commit = pin
    key = sha256((repository + "\0" + commit).encode()).hexdigest()
    cached = pack_root / (key + ".pack")
    bare = restore_root / (key + ".git")
    if not cached.is_file() or cached.is_symlink():
        return None
    subprocess.run(["git","init","--bare","--quiet","--template=",str(bare)], check=True)
    (bare/"shallow").write_text(commit+"\n")
    with cached.open("rb") as pack:
        verify = subprocess.run(["git","-C",str(bare),"index-pack","--strict","--stdin"], stdin=pack, capture_output=True)
    if verify.returncode != 0:
        print(f"Rejected cached pack from {repository}\n{verify.stderr.decode().strip()}", flush=True)
        return None
    resolved = subprocess.run(["git","-C",str(bare),"cat-file","-t",commit], capture_output=True)
    if resolved.returncode != 0 or resolved.stdout.strip() != b"commit":
        return None
    subprocess.run(["git","-C",str(bare),"update-ref","refs/heads/pinned",commit], check=True)
    return repository, bare

if mode == "seed":
    with ThreadPoolExecutor() as pool:
        list(pool.map(seed,pins))
    print(f"Seeded {len(pins)} packs in {monotonic()-started:.3f}s, {sum(p.stat().st_size for p in pack_root.glob('*.pack'))} bytes", flush=True)
    sys.exit(0)

env = {**os.environ, "MONKE_HOME": str(restore_root/"home"), "GIT_TERMINAL_PROMPT":"0", "GIT_TRACE2_EVENT": str(restore_root/"git-trace.jsonl")}
if mode == "warm":
    with ThreadPoolExecutor() as pool:
        selected = [result for result in pool.map(validate,pins) if result]
    index = int(env.get("GIT_CONFIG_COUNT","0"))
    for repository, bare in selected:
        env[f"GIT_CONFIG_KEY_{index}"] = f"url.{bare}.insteadOf"
        env[f"GIT_CONFIG_VALUE_{index}"] = repository
        index += 1
    env["GIT_CONFIG_COUNT"] = str(index)
    print(f"Validated {len(selected)} packs in {monotonic()-started:.3f}s", flush=True)

restore_start = monotonic()
subprocess.run(["timeout","--kill-after=3s","65s","bun","run","src/index.ts","skills","restore","--repo"], cwd=checkout, env=env, check=True)
print(f"Materialization {mode} {monotonic()-restore_start:.3f}s, total {monotonic()-started:.3f}s", flush=True)
events = [json.loads(line) for line in (restore_root/"git-trace.jsonl").read_text().splitlines()]
upstream = sum(event["event"] == "start" and any(arg in ("remote-https", "git-remote-https") for arg in event["argv"]) for event in events)
print("Upstream fetches", upstream)
if len(selected) == len(pins):
    assert upstream == 0, upstream
