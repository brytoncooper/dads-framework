#!/usr/bin/env bash
set -euo pipefail

proof=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cli="$proof/../bin/dad-dev.js"
temp=$(mktemp -d)
export TMPDIR="$temp"
primary="$temp/primary"
second="$temp/side checkout"
pg=""
checking_pid=""
cleanup() {
  if [ -n "$checking_pid" ]; then kill "$checking_pid" 2>/dev/null || true; fi
  for checkout in "$primary" "$second"; do
    if [ -d "$checkout" ]; then (cd "$checkout" && node "$cli" down) >/dev/null 2>&1 || true; fi
  done
  if [ -n "$pg" ]; then docker rm -f "$pg" >/dev/null; fi
  rm -rf "$temp"
}
trap cleanup EXIT

pg=$(docker run -d --publish 127.0.0.1::5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine)
for attempt in $(seq 1 20); do
  if docker exec "$pg" pg_isready -U postgres -h 127.0.0.1 >/dev/null; then break; fi
  sleep 1
done
export DADS_DEV_POSTGRES_URL="postgresql://postgres@$(docker port "$pg" 5432/tcp)/postgres"

git init -q --bare --initial-branch=main "$temp/origin.git"
git init -q --initial-branch=main "$primary"
git -C "$primary" config user.name "Fixture"
git -C "$primary" config user.email "fixture@example.test"
cp "$proof/dads.dev.json" "$proof/service.mjs" "$primary/"
mkdir "$primary/dependency"
printf '%s\n' '{"name":"slot-proof-dependency","version":"1.0.0"}' > "$primary/dependency/package.json"
printf '%s\n' '{"name":"slot-proof","version":"1.0.0","dependencies":{"slot-proof-dependency":"file:./dependency"}}' > "$primary/package.json"
printf 'node_modules/\n' > "$primary/.gitignore"
(cd "$primary" && npm install --package-lock-only --offline --no-audit --no-fund) >/dev/null
git -C "$primary" add .
git -C "$primary" commit -qm "Create app fixture"
git -C "$primary" remote add origin "$temp/origin.git"
git -C "$primary" push -qu origin main
git -C "$primary" worktree add -qb side "$second" main

(cd "$primary" && node "$cli" ready) > "$temp/ready.json"
(cd "$second" && node "$cli" ready) > "$temp/second-ready.json"
test "$(realpath "$primary/node_modules/slot-proof-dependency")" = "$primary/dependency"
test "$(realpath "$second/node_modules/slot-proof-dependency")" = "$second/dependency"
(cd "$primary" && node "$cli" up) > "$temp/primary.json" &
first_pid=$!
(cd "$second" && node "$cli" up) > "$temp/second.json" &
second_pid=$!
wait "$first_pid"
wait "$second_pid"
(cd "$primary" && node "$cli" status) > "$temp/status.json"
node "$proof/check-slots.mjs" "$temp/status.json" "$primary" "$second"

git -C "$primary" worktree add -qb candidate "$temp/merged" main
printf 'merged patch\n' > "$temp/merged/patch.txt"
git -C "$temp/merged" add patch.txt
git -C "$temp/merged" commit -qm "Write fix"
git -C "$temp/merged" push -qu origin candidate
git -C "$primary" commit -qm "Make main diverge" --allow-empty
git -C "$primary" cherry-pick candidate >/dev/null
git -C "$primary" push -q origin main

for branch in dirty locked unpushed aged process recent; do
  git -C "$primary" worktree add -qb "$branch" "$temp/$branch" main
done
printf 'preserve me\n' > "$temp/dirty/local.txt"
git -C "$primary" worktree lock "$temp/locked"
git -C "$temp/unpushed" commit -qm "Local only" --allow-empty
for branch in aged process; do
  metadata=$(git -C "$temp/$branch" rev-parse --absolute-git-dir)
  touch -t 202001010000 "$temp/$branch" "$metadata/HEAD" "$metadata/index"
done
(cd "$temp/process" && exec sleep 60) &
checking_pid=$!

(cd "$primary" && node "$cli" sweep) > "$temp/sweep.json"
test -d "$temp/merged"
(cd "$primary" && node "$cli" prune) > "$temp/prune.json"
test ! -d "$temp/merged" || { cat "$temp/prune.json"; exit 1; }
test ! -d "$temp/aged"
for path in "$primary" "$second" "$temp/dirty" "$temp/locked" "$temp/unpushed" "$temp/process" "$temp/recent"; do
  test -d "$path"
done
git -C "$primary" show-ref --verify -q refs/heads/candidate
git -C "$primary" show-ref --verify -q refs/heads/aged
(cd "$primary" && node "$cli" scratch -- node -e 'process.exit(0)')
(cd "$primary" && node "$cli" scratch -- node -e 'require("node:fs").writeFileSync("local.txt", "preserved")')
test "$(find "$temp" -path '*/dads-scratch-*/checkout/local.txt' -type f | wc -l)" -eq 1
(cd "$primary" && node "$cli" down) >/dev/null
(cd "$second" && node "$cli" down) >/dev/null
(cd "$primary" && node "$cli" status) > "$temp/stopped.json"
node "$proof/check-slots.mjs" "$temp/stopped.json" "$primary" "$second" stopped
printf 'Verified two isolated app stacks and conservative worktree removal.\n'
