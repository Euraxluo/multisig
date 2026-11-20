#!/bin/sh
# Runs the three TLC configurations and checks each against EXPECTED below.
# A MISMATCH means the model or the code moved; find out which before touching
# this table (tla-plus.md, discipline 3). Exit 0 only when every row agrees.
#
#   current    the code on origin/main, all seven invariants
#   isolation  update_organization_roster with its two guards removed
#   broken     rotate_group_key with the new key left out of the digest
set -eu
cd "$(dirname "$0")"

JAR="${TLC_JAR:-/tmp/tla2tools.jar}"
if [ ! -f "$JAR" ]; then
    curl -sSLo "$JAR" \
        https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
fi

fail=0
for cfg in current isolation broken; do
    case "$cfg" in
        current) want=ok ;;
        *) want=fail ;;
    esac
    out=$(mktemp)
    set +e
    java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -config "$cfg.cfg" \
        -workers auto Model.tla > "$out" 2>&1
    status=$?
    set -e
    if [ "$status" -eq 0 ]; then got=ok; else got=fail; fi
    if [ "$got" = "$want" ]; then
        printf 'ok        %-10s %s\n' "$cfg" "$got"
    else
        printf 'MISMATCH  %-10s got %s, expected %s\n' "$cfg" "$got" "$want"
        tail -5 "$out"
        fail=1
    fi
    rm -f "$out"
done

echo '--- repro probe ---'
if node --import=tsx repro_probe.mjs; then
    :
else
    fail=1
fi
exit "$fail"
