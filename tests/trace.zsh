#!/usr/bin/env zsh
emulate -L zsh
setopt err_return pipe_fail extended_glob
zmodload -F zsh/stat b:zstat

typeset -g ROOT=${${(%):-%x}:A:h:h}
typeset -g SCRIPTS=$ROOT/.agents/skills/sandbox/scripts
typeset -g SANDBOX=${${TMPDIR:-/tmp}%/}/ttheme-sandbox
typeset -g WORK=${${TMPDIR:-/tmp}%/}/ttheme-trace
typeset -g BIN=$WORK/bin
typeset -gA BUILT=()
typeset -ga HELPERS=()

usage() {
  print -u2 -l -- \
    'usage: mise run trace FILE [--frames FILE] [--perfetto all]' \
    '         read a trace: every interaction'"'"'s stages, the slowest stage, and a Perfetto file of the slowest' \
    '       mise run trace --watch FILE [--pid PID]' \
    '         record the front window while a shell that exports TTHEME_TRACE=FILE is used; ctrl+c stops and reads it' \
    '       mise run trace --sandbox [--runs N] [--out DIR] [--iterm | --kitty | --alacritty | --wezterm | --warp | --terminal-app]' \
    '                                [--size COLSxROWS] [--empty | --mine | palette…] -- COMMAND STEP…' \
    '         drive COMMAND through STEPs N times in a sandbox window, keys sent as real key events, and read the trace'
}

tool() {
  local src=$ROOT/tests/trace/$1.swift sum
  sum=$(md5 -q $src)
  BUILT[$1]=$BIN/$1-$sum
  [[ -x $BUILT[$1] ]] && return 0
  mkdir -p $BIN
  print -u2 "trace: building $1"
  swiftc -O -o $BUILT[$1].tmp $src
  mv -f $BUILT[$1].tmp $BUILT[$1]
}

read_trace() {
  bun $ROOT/tests/trace/report.ts "$@"
}

stop_helpers() {
  local pid
  for pid in $HELPERS; do kill -TERM $pid 2>/dev/null || :; done
  HELPERS=()
  return 0
}

watch_window() {
  local -a pid
  zparseopts -D -E -F -- -pid:=pid || { usage; return 1 }
  (( $# == 1 )) || { usage; return 1 }
  local file=${1:A}
  tool wincap
  local -a target=(--front)
  (( $#pid )) && target=(--pid $pid[-1])
  print -u2 "trace: recording the front window into $file.frames; work in the shell that exports TTHEME_TRACE=$file, then press ctrl+c here"
  trap '' INT
  $BUILT[wincap] $target --out $file.frames --seconds 3600 || :
  trap - INT
  read_trace $file --frames $file.frames
}

instance() {
  case $1 in
    --iterm) pgrep -f -- "^[^ ]*/iTerm2 -suite ttheme-sandbox( |\$)" | head -1 ;;
    --kitty) pgrep -f -- "kitty --config $SANDBOX/" | head -1 ;;
    --alacritty) pgrep -f -- "alacritty --config-file $SANDBOX/" | head -1 ;;
    --wezterm) pgrep -f -- "wezterm-gui --config-file $SANDBOX/" | head -1 ;;
    --warp) ps -axo pid=,comm= | awk '/\/Warp.app\/Contents\/MacOS\// { print $1; exit }' ;;
    --terminal-app) pgrep -x Terminal | head -1 ;;
    *) pgrep -f -- "--config-file=$SANDBOX/" | head -1 ;;
  esac
}

start_helpers() {
  local kind=$1 dir=$2 posts=$3 captures=$4 pid="" i
  local -a began=() started=() newest=()
  zstat -F %s.%N -A began +mtime -- $dir/trace.tsv
  for i in {1..1800}; do
    if [[ -e $SANDBOX/run.started ]]; then
      zstat -F %s.%N -A started +mtime -- $SANDBOX/run.started 2>/dev/null || started=(0)
      (( started[1] >= began[1] )) && pid=$(instance $kind) && [[ -n $pid ]] && break
    fi
    sleep 0.1
  done
  [[ -n $pid ]] || return 1
  [[ $kind == (--warp|--terminal-app) ]] && newest=(--newest)
  if (( captures )); then
    $BUILT[wincap] --pid $pid $newest --out $dir/frames.tsv --seconds 3600 2> $dir/wincap.log &
    print -r -- $! > $dir/wincap.pid
  fi
  if (( posts )); then
    $BUILT[keys] --pid $pid --fifo $dir/keys.fifo --trace $dir/trace.tsv 2> $dir/keys.log &
    print -r -- $! > $dir/keys.pid
    print -r -- warm > $dir/keys.fifo
  fi
  for i in {1..50}; do
    (( ! captures )) || [[ -s $dir/frames.tsv ]] && break
    sleep 0.1
  done
  sleep 0.5
  : > $dir/ready
}

sandbox_runs() {
  local -a runs=(--runs 20) out=() kind=() size=()
  zparseopts -D -E -F -- -runs:=runs -out:=out -iterm=kind -kitty=kind -alacritty=kind -wezterm=kind -warp=kind -terminal-app=kind -size:=size ||
    { usage; return 1 }
  local split=${@[(i)--]}
  (( split < $# )) || { usage; return 1 }
  [[ $runs[-1] == <1-> ]] || { usage; return 1 }
  local -a picks=(${@[1,split-1]}) steps=(${@[split+1,-1]})
  local dir=${out[-1]:-$WORK/runs/$(date +%Y%m%d-%H%M%S)} posts=1 captures=1 rc=0
  mkdir -p $dir
  dir=${dir:A}
  rm -f $dir/trace.tsv $dir/frames.tsv $dir/ready $dir/keys.fifo $dir/*.pid(N)
  : > $dir/trace.tsv
  [[ $kind[1] == (--warp|--terminal-app|--kitty) ]] && posts=0
  [[ $kind[1] == --kitty ]] && captures=0
  tool wincap
  (( posts )) && { tool keys; mkfifo $dir/keys.fifo }
  {
    print -r -- "export TTHEME_TRACE=${(q)dir}/trace.tsv SB_LINGER=1.5"
    (( posts )) && print -r -- "export SB_KEYS=${(q)dir}/keys.fifo"
    print -r -- "for i in {1..600}; do [[ -e ${(q)dir}/ready ]] && break; sleep 0.1; done"
    print -r -- "[[ -e ${(q)dir}/ready ]] || { sb_report 'trace: the recorder never started, see ${(q)dir}'; return 1 }"
    print -r -- 'while read -rs -t 0.2 -k 1; do :; done'
    print -r -- "for i in {1..$runs[-1]}; do __tt_mark run.start \$i; sb_drive ${(j: :)${(@q)steps}}; __tt_mark run.end \$i; done"
  } > $dir/run.zsh
  start_helpers "${kind[1]:-}" $dir $posts $captures > $dir/helpers.log 2>&1 &!
  print -u2 "trace: $runs[-1] runs into $dir"
  local script=$SCRIPTS/ghostty.zsh
  local -a args=($size)
  if [[ $kind[1] == --iterm ]]; then
    script=$SCRIPTS/iterm.zsh args=()
  elif (( $#kind )); then
    script=$SCRIPTS/window.zsh args=($kind)
  fi
  SB_AWAIT=7200 zsh $script $args $picks -- "source ${(q)dir}/run.zsh" > $dir/window.log 2>&1 || rc=$?
  [[ -s $dir/wincap.pid ]] && HELPERS+=($(<$dir/wincap.pid))
  [[ -s $dir/keys.pid ]] && HELPERS+=($(<$dir/keys.pid))
  stop_helpers
  local i
  for i in {1..30}; do
    (( ! captures )) || [[ $(tail -1 $dir/frames.tsv 2>/dev/null) == *$'\t'stop ]] && break
    sleep 0.1
  done
  if (( rc )) || [[ ! -e $dir/ready ]]; then
    print -u2 "trace: the window run failed (status $rc), see $dir/window.log"
    cat $dir/window.log >&2
    return 1
  fi
  local -a missed=(${(M)${(f)"$(<$dir/window.log)"}:#*drive.py:*})
  (( ! $#missed )) || print -u2 -l -- "trace: ${#missed} steps failed, so those runs stopped early:" ${(u)missed}
  if (( captures )); then
    read_trace $dir/trace.tsv --frames $dir/frames.tsv
  else
    print -u2 "trace: kitty draws nothing while its window is behind others, so this run records no screen and ends each key at its last write"
    read_trace $dir/trace.tsv
  fi
}

main() {
  trap stop_helpers EXIT
  case $1 in
    --sandbox) shift; sandbox_runs "$@" ;;
    --watch) shift; watch_window "$@" ;;
    ''|-h|--help) usage; return 1 ;;
    *) read_trace "$@" ;;
  esac
}

main "$@"
