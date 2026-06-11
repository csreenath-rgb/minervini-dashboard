"""Send triggered watchlist alerts by email (Gmail SMTP, stdlib only).

Usage: python3 send_email.py alerts.json
Reads the alerts file produced by check_alerts.mjs. Sends nothing when there
are no alerts. Requires environment variables:
  GMAIL_ADDRESS      - the Gmail account used to send
  GMAIL_APP_PASSWORD - a Gmail "app password" (not the account password)
  MAIL_TO            - recipient (optional; defaults to GMAIL_ADDRESS)
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

    email = data.get("email")
    if not email:
        print(f"Checked {len(data.get('results', []))} symbols - no alerts triggered, no email sent.")
        return 0

    sender = os.environ.get("GMAIL_ADDRESS")
    password = os.environ.get("GMAIL_APP_PASSWORD")
    recipient = os.environ.get("MAIL_TO") or sender
    if not sender or not password:
        print("WARNING: GMAIL_ADDRESS / GMAIL_APP_PASSWORD secrets are not set; "
              f"{len(data.get('alerts', []))} alert(s) were triggered but no email was sent.")
        return 0  # do not fail the workflow; alerts.json still has the details

    msg = MIMEText(email["body"])
    msg["Subject"] = email["subject"]
    msg["From"] = sender
    msg["To"] = recipient

    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as smtp:
        smtp.login(sender, password)
        smtp.sendmail(sender, [recipient], msg.as_string())
    print(f"Sent {len(data.get('alerts', []))} alert(s) to {recipient}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
