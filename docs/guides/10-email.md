# Email

fabrik connects to a mailbox you set up in it, for a provider Claude has no connector for, such as StartMail or Namecheap Private Email. It reads mail over IMAP and sends over SMTP, the standard ways mail programs do. Claude reads and searches the inbox, Sent and Drafts. It writes drafts, sends, replies and moves messages to Trash, each only once you approve it.

Gmail and Microsoft 365 have Claude connectors of their own. See the guide to adding other connectors.

## Setting a mailbox up

Ask Claude to set up a mailbox. It shows the mail setup card. On the card, type the mailbox's name, your username, the address your email is sent from and the password. Then type the IMAP server and port for reading, and the SMTP server and port for sending. For a provider fabrik knows, such as iCloud or StartMail, the card fills in the servers from your address. Leave the SMTP server empty for a mailbox Claude only reads and drafts in.

You can also type a signature. Claude adds it under every email it writes.

## An HTML signature

A signature can be an HTML file, with your logo, links and fonts. Give Claude the file and ask it to use it as the mailbox's signature. Claude shows you the signature and sets it once you approve.

Each email then goes out in two versions, and the reader's mail program shows one. The HTML version has your text in the signature's own font, with the HTML signature under it. The plain-text version has the typed signature, or the HTML signature's text when you typed none. A signature with a script in it is refused.

The logo stays on your website. Many mail programs show it only once the reader allows pictures.

fabrik signs in to both servers to check them, and keeps the password in your project's Vault, where only the mail tools read it.

Many providers need an app password in place of your usual one. Make it in your provider's account settings.

Type the password on the card, never in the chat.

## Reading

Ask "What came in from Ann this week?" or "Find the email about the tide tables". Claude reads the newest messages or searches them, then reads a message's text or a text attachment, such as a CSV or a calendar invite.

Ask Claude to keep a message in fabrik, and it saves it as a record.

Ask Claude to save an attachment, such as a PDF invoice. It tells you the file's name and where it will go in fabrik, and saves the file once you approve. fabrik then reads a PDF's text, so Claude can read it and find it when you search. A saved file can go out again as an attachment.

## Writing and sending

Ask "Email Ann the October invoice". Claude writes it as a draft in the mailbox's Drafts folder and tells you it's there. You can open it in your own mail program. It sends the draft once you approve. To send without a draft, ask Claude to send it straight away. A file you attach comes from fabrik, so Claude uploads a file from your computer to a scope first.

Before Claude sends, replies or moves a message to Trash, it shows you the From address, every recipient, the subject, the text and each attachment. It goes ahead only once you approve. A sent email is filed in Sent. When Claude changes or sends a draft, the old draft goes to Trash too. A message moved to Trash stays there until you empty it.

## Which account Claude sends from

Your business profile names the email account each business sends from: a mailbox in fabrik, or a Claude connector such as Gmail. Claude reads it before every draft. When a connector is signed in to another address, or the profile names no account, Claude stops and asks you which account to use.
