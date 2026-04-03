-- Drop the manifesto_markdown column from clubs; summary is sufficient.
alter table app.clubs drop column if exists manifesto_markdown;
