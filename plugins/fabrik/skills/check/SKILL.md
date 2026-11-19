---
name: check
description: Use when a person asks to check this computer, or whether their agent's own tools work on it. The check makes a record payload from a sample page and draws a board, from the fabrik plugin's sample files. It reports Python 3 and the browser as working or missing. It runs in one of three modes: human only, AI guided or human directed.
---

# Checking the computer

The fabrik command's page tools run on the person's computer, with these programs:

| Tool | Program |
|---|---|
| Drawing a page or board, a workbook | Python 3 |
| A page's picture, a printed PDF | Chrome, Chromium or Edge |

The agent runs each tool with Bash in the agent folder, as `node ~/.claude/plugins/marketplaces/fabrik/plugins/fabrik/cli/fabrik.mjs <tool> [<argument>=<value> ...]`. The check runs each tool on a sample file from this skill's `samples` folder, and reports each program as working or missing:

- `check.html`, a made-up state machine page titled "Valuation booking";
- `check.progress.json`, the progress of a plan titled "First release".

## Choose the mode

The person chooses the mode.

- **Human only:** the person follows the Person lines below, without the agent. They open each sample in its own program, and ask the agent for the rest.
- **AI guided:** the person asks the agent to guide them. Before each step, the agent says what the step does and shows the Person line. It follows its own line with the person watching, or asks the person to follow theirs. It stops for the person's approval at the end of each step.
- **Human directed:** the person tells the agent what to do. The agent follows its lines for each step the person directs.

Each step below gives a **Person** line and a line for the agent.

With the agent, the person's own instruction replaces a rule of this skill, such as which programs to check. The agent names the rule once and does as told. A refusal from fabrik or a tool still stands, and the agent gives it to the person with what they can do instead.

## 1. Copy the samples

- **Responsible:** the agent.
- **Person:** copies the samples into their folder. For the folder `~/fabrik`, on macOS and Linux, in Terminal:

  ```sh
  cp ~/.claude/plugins/marketplaces/fabrik/plugins/fabrik/skills/check/samples/check.* ~/fabrik/
  ```

  On Windows, in PowerShell:

  ```powershell
  Copy-Item "$env:USERPROFILE\.claude\plugins\marketplaces\fabrik\plugins\fabrik\skills\check\samples\check.*" "$env:USERPROFILE\fabrik"
  ```

- **The agent:** runs `copy_samples`, which copies each sample into the agent folder and leaves a file already there as it is. Takes the agent folder from its `agentFolder`. Each file in `differs` is not this release's sample. The agent names it, and skips the step that reads it. Step 3 reports the program that step checks as "checked once <file> is moved out of the agent folder".
- **Evidence:** the result's `copied`, `already` and `differs`.

**AI guided:** the agent names the samples copied and any that differ, and waits for the person's approval.

## 2. Use each tool on its sample

- **Responsible:** the person.
- **Person:** in a Code session on their folder, types `check this computer`.
- **The agent:**
  1. Runs `state_machine_payload` with `page_file` set to `check.html` in the agent folder, and `payload_file` set to a new file there, `check-1.json`. When that name is taken, it uses the next number. Python 3 works when the result gives the title "Valuation booking".
  2. Runs `draw_board` with `progress_files` set to `check.progress.json` in the agent folder, `purpose` set to "Check the board", and `page_file` set to a new file there, `check-1.board.html`. When that name is taken, it uses the next number. The browser works when the result gives a `picture_file`. Without one, its `picture_problem` says why.
- **Evidence:** each tool's result.

**AI guided:** the agent says what each tool gave, one line per tool, and waits for the person's approval.

## 3. Report

- **Responsible:** the agent.
- **Person:** writes down, for each program, whether its sample worked.
- **The agent:** reports one line per program: Python 3 and the browser. Each is working or missing.
- **Evidence:** the report.

**AI guided:** the agent gives the person the report, one line per program, and waits for their approval.

## Each refusal, and what the person does

- **"Python 3 is not on this computer":** Python 3 is missing. The refusal gives its install command.
- **"no Chrome, Chromium or Edge on this computer":** the browser is missing. The agent checks its pages from their outlines alone, and prints no PDF. The person installs one with the line for their system:

| Program | macOS | Windows | Debian and Ubuntu |
|---|---|---|---|
| A Chromium browser, Google Chrome or, on Windows, Microsoft Edge | `brew install --cask google-chrome` | `winget install Microsoft.Edge` | `sudo apt install chromium` on Debian, `sudo snap install chromium` on Ubuntu |

- **"No such file":** a sample is missing from the agent folder. The agent runs `copy_samples` again. Without the agent, the person copies them, as step 1 says.
- **"already exists":** the payload file's name is taken. The agent uses the next number.
