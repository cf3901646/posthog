from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("signals", "0186_signalteamconfig_onboarding"),
    ]

    operations = [
        migrations.AddField(
            model_name="signalteamconfig",
            name="implementation_repositories",
            field=models.JSONField(blank=True, db_default=[], default=list),
        ),
    ]
