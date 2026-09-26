"""summary versions

Revision ID: cf7bed8608b1
Revises: 0c0c76492809
Create Date: 2026-09-27 12:00:00
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = 'cf7bed8608b1'
down_revision = '0c0c76492809'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('summary_versions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('job_id', sa.String(length=40), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('provider', sa.String(length=16), nullable=False),
    sa.Column('summary_type', sa.String(length=40), nullable=False),
    sa.Column('instructions', sa.Text(), nullable=True),
    sa.Column('summary', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_summary_versions_job_id'), 'summary_versions', ['job_id'], unique=False)
    op.add_column('jobs', sa.Column('summary_version_id', sa.Integer(), nullable=True))

    # Backfill: every existing summary becomes its job's first (and current) version.
    # jobs.summary_type is set exactly when there is a summary (a JSON null in `summary`
    # would pass IS NOT NULL). The job's creation time stands in for the summary's;
    # legacy jobs without provider_used get "unknown".
    op.execute(
        "INSERT INTO summary_versions (job_id, created_at, provider, summary_type, summary) "
        "SELECT id, created_at, COALESCE(provider_used, 'unknown'), summary_type, summary "
        "FROM jobs WHERE summary_type IS NOT NULL"
    )
    op.execute(
        "UPDATE jobs SET summary_version_id = "
        "(SELECT MAX(v.id) FROM summary_versions v WHERE v.job_id = jobs.id) "
        "WHERE summary_type IS NOT NULL"
    )


def downgrade() -> None:
    op.drop_column('jobs', 'summary_version_id')
    op.drop_index(op.f('ix_summary_versions_job_id'), table_name='summary_versions')
    op.drop_table('summary_versions')
