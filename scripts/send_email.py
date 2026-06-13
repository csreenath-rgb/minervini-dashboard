"""Send triggered watchlist alerts by email (Gmail SMTP, stdlib only).

Usage: python3 send_email.py alerts.json

Reads the alerts file produced by check_alerts.mjs. The script is a thin
transport: all routing/grouping logic lives in check_alerts.mjs (and is
unit-tested in Node). This file just delivers each pre-built email group to
its recipients. Sends nothing when there are no alerts.

Environment variables:
  GMAIL_ADDRESS      - the Gmail account used to send
  GMAIL_APP_PASSWORD - a Gmail "app password" (not the account password)
  MAIL_TO            - owner fallback recipient (optional; defaults to GMAIL_ADDRESS)
"""
import json
import os
import smtplib
import sys
from email.mime.text import MIMEText


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else "alerts.json"
    if not os.path.exists(path):
        print("No alerts file found - nothing to send.")
        return 0
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    sender = os.environ.get("GMAIL_ADDRESS")
    password = os.environ.get("GMAIL_APP_PASSWORD")
    default_recipient = os.environ.get("MAIL_TO") or sender

    # Prefer the new per-watchlist groups; fall back to the legacy single email.
    groups = data.get("emails")
    if not groups:
        legacy = data.get("email")
        if not legacy:
            print(f"Checked {len(data.get('results', []))} symbols - no alerts triggered, no email sent.")
            return 0
        recipients = [default_recipient] if default_recipient else []
        groups = [{"recipients": recipients, "subject": legacy["subject"], "body": legacy["body"]}]

    if not sender or not password:
        print("WARNING: GMAIL_ADDRESS / GMAIL_APP_PASSWORD secrets are not set; "
              f"{len(data.get('alerts', []))} alert(s) were triggered across "
              f"{len(groups)} list(s) but no email was sent.")
        return 0  # do not fail the workflow; alerts.json still has the details

    sent = 0
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as smtp:
        smtp.login(sender, password)
        for g in groups:
            recipients = [r for r in (g.get("recipients") or []) if r]
            if not recipients and default_recipient:
                recipients = [default_recipient]
            if not recipients:
                continue
            msg = MIMEText(g["body"])
            msg["Subject"] = g["subject"]
            msg["From"] = sender
            msg["To"] = ", ".join(recipients)
            smtp.sendmail(sender, recipients, msg.as_string())
            sent += 1
    print(f"Sent {sent} email group(s) for {len(data.get('alerts', []))} alert(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
