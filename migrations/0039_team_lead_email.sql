ALTER TABLE teams ADD COLUMN lead_email TEXT;
ALTER TABLE hackathons
ADD COLUMN team_email_subject TEXT NOT NULL DEFAULT 'Doomforge team update for {{team_name}}';
ALTER TABLE hackathons
ADD COLUMN team_email_body TEXT NOT NULL DEFAULT 'Hello {{team_name}}. Track: {{assigned_track}}. Dashboard: {{dashboard_link}}.';
