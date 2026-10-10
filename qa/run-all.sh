#!/usr/bin/env bash
# qa/run-all.sh — 所有 QA 用例的统一入口（**PM 拥有，QA 只报告要加的行使**）
#
# 用法（从仓库根执行）：
#     bash qa/run-all.sh
#
# 规则：
#   * 每个用例是一个 `qa/<task-id>/<case-name>/run.sh`，必须可独立运行、可重复运行。
#   * 本脚本按字典序发现并执行它们，**一个用例失败不阻止其它用例运行**，最后打印真实总计。
#   * 退出码：全部通过 = 0；有任何失败 = 1（CI / 工程师必须能据此判断）。
#   * 用例自己负责自己的临时文件；不要把产物写进仓库。
#
# 注意（给 QA 的约定）：
#   * 用例目录名用 `<task-id>`（例如 `qa/T-relay/`）。
#   * 每个用例的 `run.sh` 必须 `set -euo pipefail`，并在最后打印 `PASS` 或 `FAIL`。
#   * 需要网络/真机/服务器的用例：在脚本里**显式检测**并把 `SKIP` 连同原因打印出来，
#     不要静默通过（静默通过会让总计数看起来是绿的，那是最坏的情况）。

set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
qa_dir="$repo_root/qa"

pass=0
fail=0
skip=0
missing=0
failed_cases=""
skipped_cases=""

echo "qa/run-all.sh — repo: $repo_root"
echo "------------------------------------------------------------"

if [ ! -d "$qa_dir" ]; then
  echo "SKIP: qa/ 目录不存在 —— 本轮还没有 QA 用例。"
  echo "总计: pass=0 fail=0 skip=1"
  exit 0
fi

# 发现用例：qa/<task-id>/<case>/run.sh（只取 run.sh，避免误跑辅助脚本）
while IFS= read -r runner; do
  case_dir="$(dirname "$runner")"
  case_name="${case_dir#"$qa_dir"/}"

  if [ ! -f "$runner" ]; then
    continue
  fi

  echo ""
  echo ">>> CASE: $case_name"
  echo "    $runner"

  # 每个用例在自己的目录里跑，用 bash 显式解释（Windows 上的 bash 也一样）
  if ( cd "$case_dir" && bash "$runner" ); then
    echo "<<< PASS: $case_name"
    pass=$((pass + 1))
  else
    rc=$?
    echo "<<< FAIL: $case_name (exit code $rc)"
    fail=$((fail + 1))
    failed_cases="$failed_cases
  - $case_name (exit $rc)"
  fi
done < <(find "$qa_dir" -mindepth 3 -maxdepth 3 -name run.sh -type f 2>/dev/null | sort)

# ---------------------------------------------------------------------------
# Go 用例：qa/<task-id>/cases_*_test.go
#
# QA may write Go cases instead of run.sh. They must live in ONE Go package with
# their own go.mod, because `go test` refuses to build a directory that is not
# inside a module. Case files are named cases_*_test.go so the shared harness
# (main_test.go / relayqa_test.go) is not counted twice.
#
# This repository runs on Windows, where `go test` inside an absolute Git-bash
# path is unreliable; the directory is converted to a Windows path first.
# ---------------------------------------------------------------------------
while IFS= read -r qa_mod; do
  qa_pkg_dir="$(dirname "$qa_mod")"
  pkg_name="${qa_pkg_dir#"$qa_dir"/}"

  # Prefer the task's own run.sh when it provides one: it reports per-case counts
  # (e.g. "pass=12"), while a bare `go test` can only report the package as one
  # result. Both are legitimate; the case-level one is more honest about how much
  # was actually checked.
  if [ -f "$qa_pkg_dir/run.sh" ]; then
    echo ""
    echo ">>> CASE-RUNNER: $pkg_name"
    echo "    $qa_pkg_dir/run.sh"
    if ( cd "$qa_pkg_dir" && bash "$qa_pkg_dir/run.sh" ); then
      echo "<<< PASS: $pkg_name"
      pass=$((pass + 1))
    else
      rc=$?
      echo "<<< FAIL: $pkg_name (exit code $rc)"
      fail=$((fail + 1))
      failed_cases="$failed_cases
  - $pkg_name (exit $rc)"
    fi
    continue
  fi

  echo ""
  echo ">>> GOPKG: $pkg_name"
  echo "    $qa_mod"

  if ( cd "$qa_pkg_dir" && go test ./... ); then
    echo "<<< PASS: $pkg_name"
    pass=$((pass + 1))
  else
    rc=$?
    echo "<<< FAIL: $pkg_name (exit code $rc)"
    fail=$((fail + 1))
    failed_cases="$failed_cases
  - $pkg_name (exit $rc)"
  fi
done < <(find "$qa_dir" -mindepth 2 -maxdepth 2 -name go.mod -type f 2>/dev/null | sort)

echo ""
echo "------------------------------------------------------------"
echo "总计: pass=$pass fail=$fail"

if [ "$fail" -gt 0 ]; then
  echo "FAILED CASES:$failed_cases"
  exit 1
fi

if [ "$pass" -eq 0 ]; then
  echo "警告: 一个用例都没跑（0 个 run.sh 或 qa/<task-id>/go.mod 被发现）——**不要**把这当成通过。"
  echo "     只有在 T-relay / T-desktop / T-mobile 的用例落地后，这个数字才有意义。"
  exit 1
fi

echo "全部用例通过。"
exit 0
