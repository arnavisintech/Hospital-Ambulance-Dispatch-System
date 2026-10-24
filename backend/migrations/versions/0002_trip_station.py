"""trip station

Trips remember the station their ambulance belonged to when they ran, so a unit rebalanced to another station (or
another hospital) never carries its trip and billing history along (hospital records are scoped by this column).
Existing rows are backfilled from each ambulance's current station: the best information an older database holds.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-25 01:25:54.199138
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0002'
down_revision: Union[str, None] = '0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('trip_records', schema=None) as batch_op:
        batch_op.add_column(sa.Column('station_id', sa.Integer(), nullable=True))
        batch_op.create_index(batch_op.f('ix_trip_records_station_id'), ['station_id'], unique=False)
        batch_op.create_foreign_key('fk_trip_records_station_id', 'dark_stations', ['station_id'], ['id'])
    op.execute("UPDATE trip_records SET station_id = "
               "(SELECT ambulances.station_id FROM ambulances WHERE ambulances.id = trip_records.ambulance_id) "
               "WHERE station_id IS NULL AND ambulance_id IS NOT NULL")


def downgrade() -> None:
    with op.batch_alter_table('trip_records', schema=None) as batch_op:
        batch_op.drop_constraint('fk_trip_records_station_id', type_='foreignkey')
        batch_op.drop_index(batch_op.f('ix_trip_records_station_id'))
        batch_op.drop_column('station_id')
