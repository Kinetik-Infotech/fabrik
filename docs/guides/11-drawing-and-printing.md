# Drawing boards and graphs, and printing

fabrik draws what it holds as cards in any Claude app, and as pages and PDFs in a Code session.

## Cards in a chat

- **Records card:** a list of your records, with filters for kind, scope and title
- **Board card:** a plan's tasks in columns by state, or a model's nodes as cards
- **Graph card:** a model's nodes and links, or a plan's tasks and what each waits on

Ask "Show me the board for the kitchen renovation", and Claude opens the card in the chat.

## Pages in a Code session

In your `fabrik` folder, Claude draws a board or a graph as an HTML page, which opens in your browser. It also draws a search's graph, and a routine as a state machine: its steps and what moves it from one to the next.

## PDFs

Ask for a PDF, such as "Print the glossary" or "Print the SOP for invoicing". Claude prints an A4 PDF in your folder:

- the glossary and the data dictionary, from fabrik's current entries
- a standard operating procedure for a routine, from its version in force
- any document or deck you ask for, such as a report

Drawing and printing in a Code session need Python 3 and a browser such as Chrome. Ask Claude to check your computer to make sure both work.
