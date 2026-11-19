---
name: code
description: Use when a person asks for analysis, a model, a cleaned or joined data set, or a chart from data. The agent writes Python or JavaScript in the agent folder and runs it with Bash, on the agent folder and the folders added to the session. It builds a live Excel model with the fabrik command's create_workbook and changes one with edit_workbook. It names each file it made, and uploads one to fabrik only once the person approves. It runs in one of three modes: human only, AI guided or human directed.
---

# Running code on data

The agent, the assistant, `@fabrik:assistant`, writes each script as a file in the agent folder, the session's folder, and runs it there with Bash. The code reads the files in the agent folder and in each folder added to the session. It writes new files in the agent folder only, and replaces no file without the person's approval.

- **Python** runs with `python3`. pandas, numpy, scipy, matplotlib and openpyxl do most of the work. When the computer lacks one, the agent names it and waits for the person's approval. It then installs it in a virtual environment at `~/.cache/fabrik-python`, and runs the code with that environment's Python.
- **JavaScript** runs with `node`, as a module.

Before a run that reaches the network, the agent says what it reaches and waits for the person's approval.

## Choose the mode

The person chooses the mode.

- **Human only:** the person follows the Person lines below, without the agent. They do the work in a spreadsheet program, such as Excel.
- **AI guided:** the person asks the agent to guide them. Before each step, the agent says what the step does and shows the Person line. It follows its own line with the person watching, or asks the person to follow theirs. It stops for the person's approval at the end of each step.
- **Human directed:** the person tells the agent what to do. The agent follows its lines for each step the person directs.

Each step below gives a **Person** line and a line for the agent.

With the agent, the person's own instruction replaces a rule of this skill, such as which language to use. The agent names the rule once and does as told. A refusal from fabrik or a tool still stands, and the agent gives it to the person with what they can do instead.

## When to run code

The agent runs code for:

- analysis of a data set, such as totals, averages, trends or a comparison;
- a model worked out from data, such as a forecast fitted to past sales;
- a cleaned data set, such as one with duplicates removed and dates in one form;
- two or more files joined into one, such as deliveries matched to orders;
- a chart drawn from data.

A live model the person changes, with inputs and formulas, is a workbook, as "Live workbook models" below says. Code works out the figures a live model starts from.

## 1. Find the data

- **Responsible:** the person.
- **Person:** opens the file in a spreadsheet program, and checks its columns and its first rows.
- **The agent:** finds the file in the agent folder, or in a folder added to the session. Runs a script that prints the file's columns, its number of rows and its first five rows. Tells the person what the file holds, in one line per column it needs.
- **Evidence:** the columns and rows the run printed.

**AI guided:** the agent gives the person the columns it found, and waits for their approval.

## 2. Agree the result

- **Responsible:** the person.
- **Person:** writes down the result they want, and the name of each file it goes in.
- **The agent:** says what the code will work out. Names each file the run will make in the agent folder, such as `fees-model.xlsx` and `fees-chart.png`. Each name is a new one. Waits for the person's approval before a run that writes a file. Runs a script that only prints at once.
- **Evidence:** the person's approval, and the file names.

**AI guided:** the agent gives the person the result and the file names, and waits for their approval.

## 3. Run the code

- **Responsible:** the agent.
- **Person:** works out the result in the spreadsheet program, with formulas, a pivot table or a chart. Saves it as a new file.
- **The agent:** writes the script in the agent folder, such as `fees-analysis.py`, and runs it with Bash. The script prints each figure the person needs to see, and writes each file step 2 named in the agent folder. Python saves a chart with matplotlib's `savefig`, and a table with pandas' `to_csv` or `to_excel`.
- **Evidence:** what the run printed, and the files it made.

When the run fails, the agent reads the error, puts the script right, and runs it again. After three runs that fail, it tells the person what stopped the run, in one line.

**AI guided:** the agent shows the person the code before it runs, and waits for their approval.

## 4. Give the result

- **Responsible:** the agent.
- **Person:** checks the figures and the chart in the spreadsheet program.
- **The agent:** gives the figures the run printed, and names each file it made by its full path. Names each file step 2 named that the run did not make. Asks the person to check the figures.
- **Evidence:** the figures, and each file's full path.

**AI guided:** the agent gives the person the figures and the files, and waits for their approval.

## 5. Upload a result to fabrik

- **Responsible:** the person.
- **Person:** names the scope and the path the file goes to.
- **The agent:** uploads a file the run made only once the person approves, in words in the chat. Before the upload, it shows one table: the file, made by the agent, the scope and the path, as the `fabrik:actor` skill's upload gives it. Then it runs the fabrik command's `upload_file`, which uploads from the agent folder.
- **Evidence:** the upload's result.

**AI guided:** the agent gives the person the file and the scope, and waits for their approval.

## Live workbook models

A live model is an Excel workbook a person works in: they change its inputs, and its formulas work out the rest when it opens. A fee calculator or a three-year forecast is one. The agent makes one with the fabrik command's `create_workbook`, and changes one with `edit_workbook`, run with Bash in the agent folder:

```sh
node ~/.claude/plugins/marketplaces/fabrik/plugins/fabrik/cli/fabrik.mjs create_workbook new_file=fees-model.xlsx sheets=@sheets.json names=@names.json formats=@formats.json rules=@rules.json
node ~/.claude/plugins/marketplaces/fabrik/plugins/fabrik/cli/fabrik.mjs edit_workbook workbook_file=fees-model.xlsx new_file=fees-model-2.xlsx edits=@edits.json
```

`@` reads an argument from a JSON file the agent writes in the agent folder first. `sheets` is a list of `{"name", "rows"}`, each row a list of values with the headings in row 1. `names` is a list of `{"name", "ref"}`, such as `{"name": "fee_rate", "ref": "Inputs!$B$2"}`. `formats` is a list of `{"sheet", "range", "format"}`. Each tool writes a new workbook in the agent folder, and never replaces one.

The scripts beside this skill do the work, with Python 3. `create_workbook.py` makes a workbook, and `edit_workbook.py` changes one. Both use `workbook_model.py` for formulas, names, number formats and input rules.

A workbook is for a model a person works in, never for the glossary, the data dictionary or other reference data. Those stay in fabrik, as the `fabrik:reference` skill keeps them.

1. **Agree the model.**
   - **Person:** writes down each input, each figure the model works out, and the workbook's name.
   - **The agent:** names the inputs, the figures and the new workbook, such as `fees-model.xlsx`, and waits for the person's approval.
2. **Build it.**
   - **Person:** builds the workbook in a spreadsheet program, with an Inputs sheet.
   - **The agent:** runs `create_workbook` with `new_file`, the sheets and their rows, and the model's `names`, `formats` and `rules`. The inputs go on a sheet of their own, named `Inputs`, each with its input rule and its name, such as `fee_rate` for `Inputs!B2`. Every other figure is a formula that uses the names, such as `=fee_rate*sale_price`, with its number format. Each formula's brackets, sheets and names are checked first. On any problem, nothing is written, and every problem is returned; the agent puts each one right and runs it again.
   - **Evidence:** the result's `file`, `sha256` and rows on each sheet.
3. **Change it.**
   - **Person:** changes the input or the row in the spreadsheet program, and saves it as a new file.
   - **The agent:** runs `edit_workbook` with the workbook as `workbook_file`, a new name as `new_file`, and the edits. Each edit is `{"sheet": "Inputs", "action": "change", "match": {"Input": "Fee rate"}, "row": {"Value": 0.02}}`, or an add with `row`. A workbook with formulas, names or rules keeps its row numbers: an added row goes after the last row, and a remove is refused.
   - **Evidence:** the result's rows added, removed and changed on each sheet.
4. **Check it.**
   - **Person:** opens the workbook, and checks each figure.
   - **The agent:** reads the workbook's inputs and formulas with a script that uses openpyxl's `load_workbook`. A formula's cell stays empty until a spreadsheet program works it out. The agent gives the person each input and formula, and asks them to open the workbook in Excel and check the figures.

**AI guided:** the agent gives the person the inputs and the figures, and waits for their approval.

## Each problem, and what the person does

- **"No module named":** a Python package is missing. The agent names it and, once the person approves, installs it in `~/.cache/fabrik-python` and runs the script again.
- **"command not found: python3" or "command not found: node":** Python 3 or Node.js is missing. The agent installs it the usual way for the person's system, once they approve. An install that asks for the computer's password runs in a Terminal tab, where the person types it.
- **"No such file or directory":** the script names a file the agent folder lacks. The agent finds the file, or asks the person to add its folder to a new session.
- **"Nothing was written.":** a workbook's sheet, formula, name, format or rule broke a rule, and each problem is listed. The agent puts each one right, and runs the tool again.
- **"already exists":** a workbook's new name is taken. The agent uses a new name.
