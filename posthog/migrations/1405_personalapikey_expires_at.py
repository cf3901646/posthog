from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("posthog", "1404_organization_inactive_quota_index"),
    ]

    operations = [
        migrations.AddField(
            model_name="personalapikey",
            name="expires_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
