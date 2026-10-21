from django.db import migrations, models


def backfill_query_updated_at(apps, schema_editor):
    SavedQuery = apps.get_model("data_modeling", "DataWarehouseSavedQuery")
    SavedQuery.objects.using(schema_editor.connection.alias).filter(
        status="Modified", query_updated_at__isnull=True
    ).update(query_updated_at=models.F("updated_at"))


class Migration(migrations.Migration):
    dependencies = [
        ("data_modeling", "0048_drop_datawarehousemodelpath_table"),
    ]

    operations = [
        migrations.AddField(
            model_name="datawarehousesavedquery",
            name="query_updated_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.RunPython(backfill_query_updated_at, migrations.RunPython.noop),
    ]
