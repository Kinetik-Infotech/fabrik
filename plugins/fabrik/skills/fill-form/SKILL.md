---
name: fill-form
description: Use when the person asks to fill in a form on a website from what fabrik holds, such as "fill in the contact form on this site with my details" or "register Ann for the event". Fills the form only from the fabrik records the person names, shows it filled, and submits only on the person's approval.
---

# Filling in a form

Load `fabrik:browse` first. Its rules hold for every step here.

## What fills the form

1. Fill only from the records the person names in the request. "My details" is the person's profile, read with `profile_get`. A named person is found with `contact_lookup` and read with `get_record`, and any other named record with `lookup_by_name` and `get_record`.
2. When a field the form needs is in none of those records, leave it empty and ask the person for it. Never guess a value, and never take one from another record.

## Filling

3. Open the form in Claude in Chrome when the site needs the person's login, and in the built-in browser otherwise. Read it with `read_page` to find its fields, or `find` for one field.
4. Fill each field with `form_input`. Type into a field with `computer` only when `form_input` can't set it.
5. Leave every field `browse` lists under "What the agent never types" empty, and ask the person to type it.
6. Tick no box that accepts terms, signs up for news or gives consent. Say which boxes the form has and leave them to the person.

## Submitting

7. Take a screenshot of the filled form with `computer`, and list each field with the value given and the record it came from. Ask "Submit the form on <site>?" with Yes and No.
8. On No, submit nothing, and leave the form filled for the person.
9. On Yes, press the form's submit button, then read the page and say what it shows, such as a thank-you message or an error.
10. End with the record `browse` describes, linked to the records the form was filled from.
