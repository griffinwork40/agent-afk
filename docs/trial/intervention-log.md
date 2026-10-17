# Intervention log and summary

Copy this document once per trial. Use tester aliases; do not paste credentials, private code, or raw traces. Log an event immediately even if it took zero minutes. "Tester asked" and "facilitator stepped in" are the only who-initiated values. Include unsolicited safety stops. Quote assistance verbatim; if the intervention involved a command, record it exactly after redacting any secret. Time in minutes is active human rescue time, not model wait time. Keep a separate row for each intervention. Use `none` for a task with no intervention in the per-tester summary, not a fabricated intervention row.

## Events

| tester | session | timestamp | phase | what they were trying | what blocked them | who initiated (tester asked / facilitator stepped in) | intervention given (verbatim) | minutes | category (install/auth/discoverability/model error/AFK bug/environment/other) | would-docs-have-fixed-it (y/n) | follow-up issue |
|---|---|---|---|---|---|---|---|---:|---|---|---|
| T1 | day 1 | ISO 8601 local time + zone | install | example only: verify binary | example only: PATH | tester asked | example only: "Check your Node version first." | 1 | install | y | URL or none |

CSV header (copy into a `.csv` file if preferred; quote values containing commas or newlines):

```csv
tester,session,timestamp,phase,what they were trying,what blocked them,who initiated (tester asked / facilitator stepped in),intervention given (verbatim),minutes,category (install/auth/discoverability/model error/AFK bug/environment/other),would-docs-have-fixed-it (y/n),follow-up issue
```

## Per-tester summary sheet (copy for T1, T2, T3)

* Tester alias: ; OS / Node / AFK version: ; repo type (no repo URL needed): ; provider/auth route (no secrets):
* Consent for observation: yes/no ; screen capture: yes/no ; artifact sharing: yes/no ; what was shared (if any):
* Install/auth elapsed:  min ; install/auth outcome: ; assistance:  min.

| session and task | start/end (with zone) | active elapsed min | end-to-end elapsed incl. overnight gap | verified completion y/n | how checked, exact command or inspection and by whom | total cost if known (USD estimate / bill / unknown) | rescue min | capabilities never discovered | final Done/Blocked receipt understood y/n and tester's paraphrase |
|---|---|---:|---:|---|---|---|---:|---|---|
| day 1 first task | | | | | | | | | |
| day 1 interruption, day 2 resume | | | | | | | | | |
| day 2 second task | | | | | | | | | |

* Intervention row IDs or timestamps: ; total human rescue minutes: ; number of unlogged interventions (should be zero):
* Interruption: checkpoint written y/n ; saved session found y/n ; interrupted tool outputs rechecked y/n ; original result verified y/n.
* Follow-up issues / unresolved Blocked conditions: ; notes on self-sufficiency without Griffin:.

## Post-trial questions (ask before explaining missing capabilities)

1. What task did you want to complete, and did you get a useful result? What convinced you it worked?
2. How did you decide what to check yourself? Was any claimed verification unclear or missing?
3. At which point did you need help, and what would you have tried without it?
4. What did the final Done or Blocked receipt mean to you? What evidence or next step did you take from it?
5. Which capability did you expect to find but never discover? Where did you look?
6. After closing the terminal, what did you think would survive? What actually survived on the next day?
7. Would you use AFK again on a different task in your own repo? Why or why not?
8. Did anything about local traces, provider data transfer, cost, or permissions surprise you?
