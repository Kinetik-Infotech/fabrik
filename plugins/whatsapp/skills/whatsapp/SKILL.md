---
name: whatsapp
description: Use when a person asks to link their WhatsApp, check it for new messages, read what someone said on WhatsApp, or unlink it. The whatsapp plugin reads WhatsApp as a linked device and saves each chat as a file in the person's private fabrik scope. It never sends, replies, reacts or marks a message read.
---

# WhatsApp

The whatsapp plugin reads the person's WhatsApp and saves each chat in fabrik. It joins their WhatsApp as a linked
device, the way WhatsApp on a computer does. The person links it once, by typing a code on their phone.

It only reads. It has no tool that sends a message, a reply or a reaction, and it never marks a message read. Baileys,
the library it connects with, still sends two things of its own on each check. It tells WhatsApp each message arrived,
so the sender sees two grey ticks. It also shows the person as unavailable, never online. The plugin never sends blue
ticks.

When the person asks Claude to send or answer a WhatsApp message, say that this plugin can't, and that they
send it from their phone.

WhatsApp keeps no history that a linked device can ask for later, the way a mailbox does. The phone sends a new
device a batch of recent chats once, when it links. If the person chooses it at linking, the plugin saves that batch
too, so their chats in fabrik start before the day they linked.

After that the plugin collects. Each check connects, takes what WhatsApp holds for this device since the last check, and
disconnects. It saves each chat as `whatsapp/<chat name>.md` in the person's private fabrik scope. fabrik's search
then finds the messages in every Claude app, at claude.ai and on the phone too.

The check runs in a Code session on the computer that holds the link. It signs in to fabrik with the person's own
saved sign-in, the one `fabrik sign-in` saved for their folder. Open the session in that folder.

## Tools

| Tool | What it does |
|---|---|
| `whatsapp_status` | Says whether WhatsApp is linked |
| `whatsapp_link` | Gives the code to type on the phone |
| `whatsapp_link_wait` | Waits for the phone to accept it |
| `whatsapp_check` | Saves the new messages in fabrik |
| `whatsapp_unlink` | Removes the link and its keys |

## Link WhatsApp

1. Call `whatsapp_status`. If WhatsApp is already linked, say so and stop, unless the person asks to link it again.
2. Ask for the WhatsApp number, in international format, such as +44 7700 900123.
3. Ask whether to bring in their recent chats as well as new messages. Tell them the phone sends recent history only
   at linking, so adding it later means linking again. Ask this before every link, and wait for their answer.
4. Call `whatsapp_link` with the number as `phone` and their answer as `history`, true or false. To link again, also
   pass `relink` true. Show the person the code
   it answers, and tell them how to enter it. On the phone with that number, they open WhatsApp → Settings → Linked
   devices → Link a device. They tap Link with phone number instead, and type the code.
5. Tell them the phone may ask whether someone else asked for the code. It was them, so they carry on and approve
   the link. Without that, the link doesn't finish.
6. Call `whatsapp_link_wait`. While it says it is still waiting, call it again. Don't ask for a new code unless the
   person asks, or the tool says the code ran out. With history, the phone keeps sending chats for a few minutes after
   it accepts the code. The tool waits for the last of them and then says how many chats and messages came.
7. Once it says WhatsApp is linked, call `whatsapp_check` for the first time. With history, call it again while it
   says chats wait.

When the phone sends more history after the wait ends, the next check saves it.

A person who linked without history and now wants it links again with `relink` true and `history` true. Tell them
first that WhatsApp sees each link as a new device, which adds to the risk below. `whatsapp_status` says whether the
link brought history.

## Check for messages

Call `whatsapp_check` when the person asks to check WhatsApp, or before answering what someone said on WhatsApp
lately. It answers each chat file that changed and how many messages it gained.

- The chats go in the person's private fabrik scope. If they own more than one, the tool names them. Ask which one,
  and call it again with that code as `scope`. The plugin remembers it.
- If they own none, an administrator adds one for them, as section 20 of the `fabrik:records` skill describes.
- A check saves at most 20 chats, oldest first, so fabrik's search can read the files in its own time. The other chats
  wait on the computer, and the answer says how many. Check again to save the next 20.
- No chat file passes 1 MB. When a chat's messages would take its file past that, its older days move to files of
  their own, each holding one month or part of one, such as `whatsapp/Kate 2026-09.md`. The newest days stay in
  `whatsapp/Kate.md`.
- If fabrik can't be reached, the messages wait on the computer, and the next check saves them. WhatsApp has already
  handed them over, so they are nowhere else.
- A photo, video, voice note or document is noted in the file by its kind, its name and its caption. The plugin
  doesn't download it. The person opens it on their phone.

Tell the person to check at least once a week. WhatsApp drops a linked device that hasn't connected for about 14
days, and the messages it held for it are lost.

## Read what was saved

Each chat file starts with the chat's full name, and the other person's number when WhatsApp gives it. Each day has
its own heading, and each message is a line with its time, the sender and the text. The person's own messages show as
Me. A group's file is named after the group.

fabrik's storage takes only plain letters, digits, spaces and a few marks in a file name. So a file name drops accents,
emoji and curly quotes, and the first line keeps the name as WhatsApp has it. A group whose name WhatsApp hadn't given
yet is saved as `whatsapp/group <id>.md`. It keeps that file once the name comes, and the name goes in its first line.

WhatsApp names some people only by an internal id, not a phone number. The plugin shows such a sender by name or
number once it learns them. Until then the line shows them as `Unknown (WhatsApp id …)`.

When a check finds one chat saved in two files, it adds the second file's messages to the first and says so. The
person can then delete the second file in fabrik.

To answer a question about WhatsApp, search fabrik for the person's or the group's name and the words they asked
about. Then read the chat's file with fabrik's `read_file`. In a Code session on the linked computer, check first, so
the answer includes the newest messages.

## Unlink WhatsApp

Ask the person before unlinking. Then call `whatsapp_unlink`. It saves what WhatsApp still holds for this device,
asks WhatsApp to drop the device, and deletes the folder of keys on this computer. The chat files stay in fabrik. If
WhatsApp couldn't be reached, tell the person to remove the device on their phone, under Settings → Linked devices.

## The link's keys

The link's keys stay on this computer, in `~/.config/fabrik/whatsapp/<fabrik email>`, a folder only the person can
read. They never go to fabrik, and no tool's answer shows them. Anyone who copies that folder can read the person's
WhatsApp, so it is never sent, uploaded or pasted anywhere.

## The risk

The plugin uses Baileys, a library WhatsApp doesn't make or support. WhatsApp can ban a number it flags. A short check
that only reads is the lowest-risk way to use it, but the risk stays. Tell the person this before they link.
