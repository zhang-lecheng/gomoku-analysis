#!/usr/bin/env python3
"""Run comparable single-thread Rapfi searches; report numeric coordinates.

Usage: python3 tests/native-reference.py /path/to/pbrain-rapfi /path/to/config-directory
The configuration directory must contain the matching config.toml and weights.
"""
import json
import os
import re
import subprocess
import sys
import time

BLACK = 'F10 H8 I8 J8 H7 J6 H5'.split()
WHITE = 'K8 I7 J7 K7 G6 H6 I6'.split()

def xy(s):
    return ord(s[0]) - ord('A'), 15 - int(s[1:])

def name(x, y):
    return chr(ord('A') + x) + str(15-y)

assert xy('A1') == (0, 14) and xy('F11') == (5, 4)
assert len(set(BLACK + WHITE)) == 14
assert len(BLACK) == len(WHITE) == 7

if len(sys.argv) != 3:
    sys.exit(__doc__)
binary, cwd = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
for trial in os.environ.get('TRIALS', 'root,F11,L7').split(','):
    black = BLACK + ([] if trial == 'root' else [trial])
    # Interleave physical colors to avoid artificial pass moves in YXBOARD.
    # The first row must be black: Rapfi treats that first stone as BLACK.
    rows = []
    for i in range(len(black)):
        x, y = xy(black[i]); rows.append(f'{x},{y},1')
        if i < len(WHITE):
            x, y = xy(WHITE[i]); rows.append(f'{x},{y},2')
    commands = ['START 15','INFO rule 0','INFO timeout_turn '+os.environ.get('TIME_MS','3000'),
        'INFO timeout_match 10000000','INFO max_memory '+str(int(os.environ.get('HASH_MB','128'))*1024*1024),
        'INFO thread_num 1','INFO show_detail 2','YXBOARD', *rows, 'DONE','YXNBEST 1']
    proc = subprocess.Popen([binary], cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1)
    started = time.monotonic()
    proc.stdin.write('\n'.join(commands)+'\n'); proc.stdin.flush()
    info = {}
    while True:
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError(f'engine exited early: {info}')
        line = line.strip()
        if line.startswith('INFO '):
            parts = line.split(' ',2)
            if len(parts)==3: info[parts[1]] = parts[2]
        if re.fullmatch(r'\d+,\d+',line):
            x,y = map(int,line.split(',')); break
    elapsed = time.monotonic()-started
    proc.stdin.write('END\n'); proc.stdin.flush(); proc.wait(timeout=10)
    print(json.dumps({'extra_black':trial,'side_to_move':'black' if trial == 'root' else 'white','move_xy':[x,y],
        'move':name(x,y),'eval':info.get('EVAL'),'nodes':info.get('TOTALNODES'),
        'engine_ms':info.get('TOTALTIME'),'wall_s':round(elapsed,3)}))
