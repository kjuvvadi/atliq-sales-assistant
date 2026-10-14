# AtliQ Sales & CRM Assistant (prototype)

Capstone 1, Step 5. A working prototype of the assistant described in the PRD: it reads the sales team's emails and meeting notes, and prepares CRM changes for a person to approve.

## What it does

| Tab | What you see | AI or rules? |
|---|---|---|
| **Sources** | The 34 email threads and 16 meeting notes from the dataset, each linked to its CRM records. Press **Analyse** to have the model read one, or **Analyse all remaining**. | Linking is rules. Reading is AI. |
| **Review** | The model's suggestions: new leads, CRM updates, next steps (promises and client deadlines) and possible opportunities. Each shows the quoted line it came from. Approve, edit or reject. | AI, then your decision |
| **Today** | The daily list: approved next steps sorted by overdue, due date, deal size and waiting time, with a filter per seller. | Rules |
| **CRM** | The 40 CRM records with checks: possible duplicates, no owner, no follow-up date, no deal value, no recent contact. Cells changed by an approval are green. | Rules |
| **Activity** | A record of every approval, rejection and completed step. The latest action can be undone. | n/a |
| **Guardrails** | How each safety rule from the PRD is enforced. | n/a |

## Guardrails built into the code

- **Nothing changes without approval.** The CRM copy changes only when you press Approve. There is no send function, so the assistant cannot contact a client.
- **Every suggestion is grounded.** The model must quote its source. The server checks the quote appears word for word in the email or note and drops the suggestion if not (`api/analyze.js`). The browser checks again.
- **No guessing.** Missing details come back empty and show as "not stated". Lead IDs, owners, dates and contact emails from the model are checked against the data and removed if they do not match.
- **Unsure means "please confirm".** Vague dates ("next week") get no date and are marked for a person to confirm.
- **Dataset only.** The server accepts an item ID from the bundled dataset, not free text. Text inside an email is treated as data, never as instructions.
- **Flags, not fixes.** Duplicates are pointed out; nothing is merged or deleted automatically.

## Project layout

```
api/analyze.js      Serverless function: reads one email or note with the AI model on Groq, checks the answer
api/status.js       Tells the page whether the AI key is set
public/index.html   The page
public/app.js       Screens, approvals, daily list (runs in the browser)
public/lib/core.js  Rules shared by browser and server: matching, duplicates, grounding check, sorting
public/data.js      The dataset, packaged for the app (generated from dataset/)
dataset/            The original capstone files (CRM export, emails, meeting notes)
preview.ps1         Local preview on Windows without Node (no AI)
```

## Deploy to Vercel (free tier)

You need a GitHub account, a Vercel account and a Groq API key (free at console.groq.com).

1. Put this folder in a new GitHub repository:
   ```bash
   git init
   git add .
   git commit -m "AtliQ Sales and CRM Assistant prototype"
   git branch -M main
   git remote add origin https://github.com/<your-user>/atliq-sales-assistant.git
   git push -u origin main
   ```
2. In Vercel, choose **Add New → Project** and import the repository. Leave the framework as **Other** and the build settings empty.
3. Under **Environment Variables**, add `GROQ_API_KEY` with your key. Optionally add `ANALYSIS_MODEL` (default `openai/gpt-oss-120b`; `openai/gpt-oss-20b` is smaller and faster).
4. Press **Deploy** and open the URL. The chip at the top right should read "AI connected".

There are no packages to install and no build step. The API key stays on the server and is never sent to the browser. Never put the key in the code or commit it to GitHub.

## Run it locally

- **With Node 20+ and the Vercel CLI** (full app, including AI):
  ```bash
  npx vercel dev
  ```
  Put `GROQ_API_KEY=...` in a `.env.local` file first (this file is ignored by git).
- **Without Node, on Windows** (screens and rules only, no AI):
  ```bash
  powershell -ExecutionPolicy Bypass -File preview.ps1
  ```
  Then open http://localhost:8123.

## How to demo it

1. Open **CRM**: the rules already show both duplicate pairs and the records with no owner or follow-up date.
2. Open **Sources** and analyse a few items, for example the ShopSwift, FinEdge and Harbor & Finch emails.
3. Open **Review**: read the quoted line, press "show source", then approve, edit or reject.
4. Open **Today**: the approved next steps appear in order, with the reason for each.
5. Open **Activity** and undo the last action.

## Limits of this prototype

- **Different model from the PRD.** The PRD proposes Claude Haiku and Sonnet. This prototype runs an open model (`openai/gpt-oss-120b`) hosted on Groq, because Groq has a free tier. A single call per email or note finds leads, promises, opportunities and CRM mismatches together. Duplicates, missing fields and the daily-list order are rules, not AI.
- **The free tier is slow in bulk.** Groq allows only a few requests a minute on the free plan. The app waits and retries by itself, so "Analyse all remaining" can take 15 minutes or more for 50 items. Analysing a handful for a demo takes seconds each.
- **The model still makes mistakes.** In testing it once proposed a company as a new lead when it was already in the CRM, and sometimes suggested a status change on thin evidence. The code checks catch some of this and mark it "please confirm"; the approval step is there for the rest.
- **The same task can appear twice.** If two sources mention the same promise (for example an email and a meeting note), both produce a next step. Reject the second one in Review.
- **Storage is the browser.** Analyses, approvals and the activity record live in your browser's local storage, so each visitor has their own copy. A shared database and sign-in are the next step.
- **"Today" is fixed at 10 July 2026**, as the dataset requires.
- **Reads exported files only.** There is no live mailbox or CRM connection.
- **Dataset additions:** none. The app uses the capstone dataset as provided.
- **Cost:** measured at about 1,700 input and 900 output tokens per item during testing. On Groq's free tier this costs nothing.
