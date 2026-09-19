#!/bin/bash

TASK_FILE="claude_loop_task.md"
ALL_DONE_MARKER="GGGG全部完成GGGG"
ALL_DONE_OUTPUT="${ALL_DONE_MARKER}${ALL_DONE_MARKER}"
PROMPT="1.从 ${TASK_FILE} 获取一条任务进行工作，完成后将任务标记为完成，不要启动子agent，直接在主agent中完成，成功完成后修改 ${TASK_FILE}，失败则不修改，输出错误。
2.如果任务完成，则输出\"任务完成\"
3.只有目标文件中所有任务及子任务均已完成并验证，才在 ${TASK_FILE} 文件末尾另起一行写入\"${ALL_DONE_MARKER}\"两遍，中间不要有空格、换行或其他间隔，不重复添加已有的结束标志行；然后连续输出相同标志两遍。不要把完整的连续双标志写入规则、示例或未完成任务。"

LAST_OUTPUT=""
SAME_COUNT=0
LAST_MD5=""

while true; do
    # 记录任务文件修改前的 MD5（如果文件存在）
    if [ -f "$TASK_FILE" ]; then
        LAST_MD5=$(md5sum "$TASK_FILE" | awk '{print $1}')
    else
        LAST_MD5=""
    fi

    echo "[$(date)] 开始调用 claude code ..."
    OUTPUT=$(claude --dangerously-skip-permissions -p "$PROMPT" 2>&1)
    EXIT_CODE=$?
    echo "[$(date)] 输出: $OUTPUT"

    # 命令返回后优先检查文件，完成标志不受输出内容或退出码影响。
    if [ -f "$TASK_FILE" ] && grep -Fq -- "$ALL_DONE_OUTPUT" "$TASK_FILE" 2>/dev/null; then
        echo "[$(date)] 任务文件标记全部完成，退出。"
        exit 0
    fi

    # 检查是否遇到 429 错误
    if echo "$OUTPUT" | grep -qi "429"; then
        echo "[$(date)] 检测到 429 错误，等待 5 分钟后重试..."
        sleep 300
        continue
    fi

    # 检查是否全部完成
    if echo "$OUTPUT" | grep -Fq -- "$ALL_DONE_OUTPUT"; then
        echo "[$(date)] 所有任务已完成，退出。"
        exit 0
    fi

    # 检查是否输出"任务完成"（完整结束标志已先判断）
    if echo "$OUTPUT" | grep -q "任务完成"; then
        echo "[$(date)] 任务完成，10 秒后继续下一轮。"
        # 重置连续相同计数
        LAST_OUTPUT="$OUTPUT"
        SAME_COUNT=1
        sleep 10
        continue
    fi

    # 其他情况：等待1分钟
    echo "[$(date)] 其他结果，1 分钟后重试。"

    # --- 连续相同输出 & 文件无改动检测 ---
    # 获取当前文件 MD5
    CURRENT_MD5=""
    if [ -f "$TASK_FILE" ]; then
        CURRENT_MD5=$(md5sum "$TASK_FILE" | awk '{print $1}')
    fi

    if [ "$OUTPUT" = "$LAST_OUTPUT" ] && [ "$CURRENT_MD5" = "$LAST_MD5" ]; then
        SAME_COUNT=$((SAME_COUNT + 1))
        echo "[$(date)] 连续相同输出且文件未改动，计数: $SAME_COUNT/3"
    else
        # 输出或文件发生变化，重置计数
        LAST_OUTPUT="$OUTPUT"
        LAST_MD5="$CURRENT_MD5"
        SAME_COUNT=1
    fi

    if [ $SAME_COUNT -ge 3 ]; then
        echo "[$(date)] 连续3次输出相同且文件无改动，退出循环。"
        exit 0
    fi

    sleep 60
done
