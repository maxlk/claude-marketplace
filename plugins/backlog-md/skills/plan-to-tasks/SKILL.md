---
name: plan-to-tasks
description: Break a spec, plan or feature request into well-formed Backlog.md tasks. Use when asked to plan work onto the board, decompose a feature, or turn a document into tasks.
argument-hint: "<spec, file path, or description>"
allowed-tools: Bash(backlog *), Bash(backlog-md *), Read, Grep, Glob
---

# Plan work into tasks

Input: $ARGUMENTS

1. Read the input and the relevant code. Read `backlog instructions task-creation` and `backlog-md policy`.
2. Check for overlap first: `backlog search "<topic>" --plain`.
3. Draft the breakdown as a table for the user: title, one-line outcome, dependencies, milestone. Tasks should each be independently shippable, and sized for one focused session. Ask for changes before creating anything if there are more than three tasks.
4. Create in dependency order, so that IDs exist when referenced, and include everything the create gate needs:
   `backlog task create "Title" -d $'Why and what' --ac "Observable outcome" --ac "..." --dep TASK-1 -m "V1" -l feature --priority medium`
   Acceptance criteria describe observable outcomes, not implementation steps. Leave plans for `/backlog-md:start`, when the code is being looked at.
5. Report the created IDs and the suggested first task.

Use `-p <id>` for genuine subtasks of a parent. Don't invent milestones: ask if none fits.
