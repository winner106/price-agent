import { Migration } from '@mikro-orm/migrations'

export class Migration20261125190000_factory_quotes extends Migration {
  override up(): void {
    this.addSql(`create table "factory_quote_records" (
      "id" uuid primary key, "tenant_id" uuid not null, "organization_id" uuid not null,
      "kind" text not null check ("kind" in ('quote', 'template')), "title" text not null,
      "revision" int not null check ("revision" >= 0), "state" jsonb not null,
      "updated_at" timestamptz not null, "created_at" timestamptz not null);`)
    this.addSql(`create index "factory_quote_records_scope_idx" on "factory_quote_records" ("tenant_id", "organization_id", "kind", "updated_at");`)
    this.addSql(`create table "factory_quote_events" (
      "id" uuid primary key, "record_id" uuid not null references "factory_quote_records" ("id"),
      "tenant_id" uuid not null, "organization_id" uuid not null, "actor_id" uuid not null,
      "token" uuid not null, "action" text not null, "fingerprint" text not null, "revision" int not null,
      "details" jsonb not null, "created_at" timestamptz not null,
      constraint "factory_quote_events_idempotency_uq" unique ("record_id", "actor_id", "token"));`)
  }
  override down(): void {
    this.addSql('drop table "factory_quote_events";')
    this.addSql('drop table "factory_quote_records";')
  }
}
