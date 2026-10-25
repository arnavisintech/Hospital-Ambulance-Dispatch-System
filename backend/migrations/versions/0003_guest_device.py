"""guest device

users.is_guest marks accounts made by the no-account SOS path (existing rows: false); users.guest_device_hash is the
SHA-256 of the phone's random device id, so a retried guest SOS returns the same account.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-25 13:33:14.659640
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0003'
down_revision: Union[str, None] = '0002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(sa.Column('is_guest', sa.Boolean(), nullable=False, server_default=sa.false()))
        batch_op.add_column(sa.Column('guest_device_hash', sa.String(length=64), nullable=True))
        batch_op.create_unique_constraint('uq_users_guest_device_hash', ['guest_device_hash'])


def downgrade() -> None:
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_constraint('uq_users_guest_device_hash', type_='unique')
        batch_op.drop_column('guest_device_hash')
        batch_op.drop_column('is_guest')
