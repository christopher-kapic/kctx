# Prisma Schema Guidelines

Conventions for writing and updating Prisma models in this repo. Read this **before** designing a new model or refactoring an existing one.

For the *workflow* of editing a schema and pushing it to the database, see [schema-changes-recipe.md](./schema-changes-recipe.md). For the deploy mechanics (the deploy-gated db-applier job, the `APPLY_SCHEMA` entrypoint mechanism, and the advisory lock), see [schema-push.md](./schema-push.md).

## Key principles

- Explicit, bidirectional relationships
- Consistent naming conventions (PascalCase models, camelCase fields)
- Every model has `id`, `createdAt`, `updatedAt`
- Foreign keys are always indexed
- `onDelete` and `onUpdate` are always declared explicitly
- Frequently repeated values are normalized into their own model
- Enums for fixed value sets, not free-form strings
- Enums for owned state, even when the state set currently has only two values
- Money is never a floating-point type — integer minor units (or `Decimal`), never `Float`

## Naming conventions

### Models

- **PascalCase** for model names: `Category`, `ProductVariant`, `OrderItem`
- Singular, not plural: `User` not `Users`

### Fields

- **camelCase** for scalar field names: `createdAt`, `updatedAt`, `isPublished`
- **PascalCase** for relation field names — match the target model name: `Category`, `Product`, `User`
- Foreign keys use a **camelCase + `Id` suffix**: `categoryId`, `userId`, `productId`

### Enums

- **PascalCase** for enum names: `Status`, `PricingType`
- **SCREAMING_SNAKE_CASE** for enum values: `DRAFT`, `PUBLISHED`, `ARCHIVED`

## Required fields on every model

Always include these three fields:

```prisma
model Example {
  id        String   @id @default(cuid(2))
  createdAt DateTime @default(now())
  updatedAt DateTime @default(now()) @updatedAt
  // ... other fields
}
```

### Why CUID2 over auto-increment integers

- Collision-resistant — generated client-side without coordinating with the database
- Secure — not guessable or enumerable, so nothing leaks row counts or growth rate (unlike `/orders/1042`)
- Reasonable index performance for the sizes most internal apps reach

If you have a specific need (raw query performance on hot tables, sortable IDs, etc.), `uuid(7)` (time-ordered UUID) and `nanoid()` are also acceptable. Default to `cuid(2)`.

### Why `@default(now()) @updatedAt` together (not `@updatedAt` alone)

`@updatedAt` only updates the field on subsequent writes — without `@default(now())`, the field is `null` (or errors) on the first insert. Always use both.

```prisma
// ✅ Correct
updatedAt DateTime @default(now()) @updatedAt

// ❌ Wrong — null on initial creation
updatedAt DateTime @updatedAt
```

## Slugs and public identifiers

Models that appear in URLs need a second identifier alongside `id`. **Which kind you need depends on whether a human should be able to read the URL**, and getting this backwards is the most common mistake on this stack.

### Human-readable slug — the default for anything users see or share

```prisma
model Article {
  id    String @id @default(cuid(2))
  title String
  slug  String @unique          // ← no @default: derived from the title
  // ...
}
```

**No `@default(cuid(2))` on the slug.** A slug's entire job is to be readable — `/blog/how-we-cut-load-times` tells a person (and a search engine, and a link preview) what they are about to open. A slug defaulted to a cuid2 produces `/blog/clx7f9a2b0000qk3m8h2n4p1x`, which is a primary key wearing a slug's name: it satisfies "the model has a slug" while delivering none of the benefit.

Populate it at create time by slugifying the title, with a numeric suffix on collision. Use the shared helpers rather than hand-rolling:

```ts
import { slugify, uniqueSlug } from "@starter/api/lib/slug";

const slug = await uniqueSlug(slugify(input.title), (candidate) =>
  prisma.article.findUnique({ where: { slug: candidate }, select: { id: true } }).then(Boolean),
);
```

Alternative names, when the meaning is more specific: `username` for user accounts, `handle` for social profiles, `slug` for posts, articles, and products.

### Opaque public identifier — when readability would hurt

Sometimes a readable URL leaks something. A slug built from a private document title, a customer name, or an invoice number tells anyone with the link more than they should know, and sequential-looking values invite enumeration. For those, keep an opaque column — but name it for what it is, so nobody mistakes it for a slug:

```prisma
model Invoice {
  id       String @id @default(cuid(2))
  publicId String @unique @default(cuid(2))   // opaque on purpose
  // ...
}
```

Use `publicId` in the URL and keep `id` internal. This is also the right shape for share links and preview tokens, where unguessability *is* the feature.

### Which one do I need?

| The URL is… | Use |
|---|---|
| Public, shareable, indexable (blog post, product, profile) | `slug String @unique`, derived from the title |
| Private but link-shared (share link, draft preview, invoice) | `publicId String @unique @default(cuid(2))` |
| Admin-only or an edit workspace | the raw `id` — the slug is mutable, so an admin URL keyed on it breaks on rename |

The `@unique` constraint on either is what enables fast lookups and what makes the URL a valid lookup key.

Routing side of this decision: [auth-and-routing § Dynamic segments](./auth-and-routing.md#dynamic-segments--slugs-in-user-facing-urls-ids-in-admin). SEO side: [ssr-for-articles](./ssr-for-articles.md).

## Relationships

All relationships are explicit and bidirectional. Use `@relation` with explicit `fields` and `references`, and **always declare `onDelete`**.

### Basic pattern

```prisma
model Author {
  id    String @id @default(cuid(2))
  name  String
  Posts Post[]
}

model Post {
  id       String @id @default(cuid(2))
  title    String
  authorId String
  Author   Author @relation(fields: [authorId], references: [id], onDelete: Cascade)

  @@index([authorId])
}
```

### Picking `onDelete`

Use your judgement based on the semantics. Common choices:

- **`Cascade`** — delete the child when the parent is deleted. Use for dependent data (translations, details, junction tables, comments owned by a post).
- **`Restrict`** — refuse to delete the parent if any children exist. Use when the child is independent and shouldn't be silently removed (deleting a `Category` should not silently delete every `Product` in it).
- **`SetNull`** — null out the foreign key when the parent is deleted. Requires the relation field to be optional (`?`). Use when the child can outlive the parent (deleting a `User` who authored an `Article` might null `authorId` so the article remains).
- **`NoAction`** — database-level constraint. Similar to `Restrict` but evaluated at transaction commit. Rarely the right choice in application code.

If the right answer isn't obvious, **ask a human** rather than guessing. Picking the wrong `onDelete` can silently destroy or orphan data.

### Named relations (when a model has multiple relations to the same target)

If a model points at the same target model more than once, Prisma cannot infer which foreign key belongs to which relation. You must give each relation a name:

```prisma
model User {
  id              String     @id @default(cuid(2))
  ownedDocuments  Document[] @relation("DocumentOwner")
  sharedDocuments Document[] @relation("DocumentEditor")
}

model Document {
  id       String @id @default(cuid(2))
  ownerId  String
  Owner    User   @relation("DocumentOwner",  fields: [ownerId],  references: [id], onDelete: Cascade)
  editorId String
  Editor   User   @relation("DocumentEditor", fields: [editorId], references: [id], onDelete: SetNull)
}
```

The relation name string is arbitrary — pick something descriptive. Both sides of each relation must use the same string.

### Many-to-many

Always use an **explicit junction table** (not the implicit `@relation` shorthand). Explicit junction tables let you add fields like `order`, `role`, or `createdAt` later without a destructive migration.

```prisma
model Post {
  id           String        @id @default(cuid(2))
  PostsOnTags  PostsOnTags[]
}

model Tag {
  id           String        @id @default(cuid(2))
  PostsOnTags  PostsOnTags[]
}

model PostsOnTags {
  postId String
  Post   Post   @relation(fields: [postId], references: [id], onDelete: Cascade)
  tagId  String
  Tag    Tag    @relation(fields: [tagId], references: [id], onDelete: Cascade)

  @@unique([postId, tagId])
  @@index([tagId])
}
```

Junction-table naming convention: `<ModelA>On<ModelB>` or `<ModelA>In<ModelB>`. Always include the composite unique constraint on both foreign keys.

## Indexing

**The most common production-killer is missing indexes.** A schema that works fine with 100 users dies at 1,000 because the database has to scan every row to answer queries. Indexes let it jump straight to the right rows.

### Rules

1. **Always index foreign keys.** Prisma does *not* auto-create indexes on `@relation` fields (unlike some ORMs). Every `xId` field that participates in a `@relation` needs an `@@index([xId])`.

2. **Index any field used in `WHERE`, `ORDER BY`, or `JOIN` clauses.**

3. **Use compound indexes for common query patterns.** If you frequently query by multiple fields together, a compound index is far more efficient than separate single-field indexes.

4. **`@@unique` is also an index** — you don't need a separate `@@index` for the same fields.

### Example

```prisma
model Comment {
  id        String   @id @default(cuid(2))
  postId    String
  Post      Post     @relation(fields: [postId], references: [id], onDelete: Cascade)
  authorId  String
  Author    User     @relation(fields: [authorId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now())
  content   String

  @@index([postId, createdAt])  // "comments on this post, sorted newest first"
  @@index([authorId])           // "all comments by this user"
}
```

### Compound index ordering matters

Put the field you filter by (equality) first, the field you sort by (range) second:

- `@@index([columnId, order])` ✅ supports `WHERE columnId = X ORDER BY order`
- `@@index([order, columnId])` ❌ does not — `order` is a range field, can't be the first key

### Trade-offs

Indexes speed up reads but slow down writes (every insert/update has to update the indexes). Don't blindly index every column — only fields you actually query. But when in doubt, add the index; the write overhead is almost always worth it for any table that gets queried.

## Unique constraints

Use `@unique` on fields that should be globally unique (`email`, `slug`, `username`).

Use `@@unique([a, b])` for composite uniqueness — particularly on junction tables and translation/detail models:

```prisma
model UserSetting {
  userId String
  User   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  key    String
  value  String

  @@unique([userId, key])  // one value per key per user
}
```

## Ordering strategy

For models that need arbitrary ordering (kanban boards, menu items, navigation), use an integer `order` field with **gaps**:

```prisma
model NavItem {
  id    String @id @default(cuid(2))
  label String
  order Int?

  @@index([order])
}
```

Insert with values like `100, 200, 300` — gaps of 100 mean you can insert ~99 items between any two positions without renumbering. Moving an item just sets its `order` value; no other rows update. Only when a gap is exhausted do you need to renumber the affected range.

For very high-frequency reordering (real-time collaborative editing), consider a `Decimal` or `Float` `position` field where insertions use `(a + b) / 2`. For 99% of use cases, the integer-with-gaps approach is simpler and sufficient.

## Data normalization

Pull frequently repeated string values into their own model. This prevents inconsistencies (`"New York"` vs `"New York City"`) and means a rename happens once instead of N times.

```prisma
// ❌ Don't store the city as a free-form string on every Address
model Address {
  id     String @id @default(cuid(2))
  city   String  // every typo becomes a permanent variant
  street String
  zip    String
}

// ✅ Normalize into a City model
model State {
  id     String @id @default(cuid(2))
  code   String @unique  // "CA", "NY"
  name   String
  Cities City[]
}

model City {
  id      String @id @default(cuid(2))
  stateId String
  State   State  @relation(fields: [stateId], references: [id], onDelete: Restrict)
  name    String

  @@unique([stateId, name])
  @@index([stateId])
}

model Address {
  id     String @id @default(cuid(2))
  cityId String
  City   City   @relation(fields: [cityId], references: [id], onDelete: Restrict)
  street String
  zip    String

  @@index([cityId])
}
```

Use your judgement about what to normalize. Rule of thumb: if the same string would appear on >100 rows and changing it would require updating all of them, normalize.

## Money — never floating point

Binary floats cannot represent most decimal amounts exactly (`0.1 + 0.2 !== 0.3`), so sums drift and equality checks fail. Never use `Float` for an amount of money — in the Prisma schema, in oRPC contracts, or in any arithmetic in between.

- **Default: integer minor units.** Store cents (or the currency's smallest unit) as `Int` — `BigInt` if totals can exceed ~21 billion cents. Exact arithmetic, no rounding surprises, trivially serializable. Name the field so the unit is unambiguous: `priceCents`, `amountMinor`.
- **`Decimal` is acceptable** when you genuinely need fractional-unit precision (per-unit rates, exchange rates, tax factors) — but Prisma returns `Decimal.js` objects that don't JSON-serialize as numbers, so convert explicitly at the oRPC boundary.
- **Store the currency** alongside any amount that could ever be multi-currency: `currency String` (ISO 4217, e.g. `"usd"`) next to `amountCents`.
- Format for display in the UI with `Intl.NumberFormat` at render time — never store formatted strings.

```prisma
// ❌ Float drifts — sums and comparisons silently break
model Order {
  total Float
}

// ✅ Integer minor units + explicit currency
model Order {
  totalCents Int
  currency   String @default("usd")
}
```

## Enums and state fields

Use enums for fixed sets of values instead of free-form strings:

```prisma
enum Status {
  DRAFT
  PUBLISHED
  ARCHIVED
}

model Article {
  id     String @id @default(cuid(2))
  status Status @default(DRAFT)
}
```

Use an enum instead of a Boolean for any data you control when the field
represents a named state that could plausibly gain more states later. This
applies even when the first version only has two states.

```prisma
enum ReviewState {
  PENDING
  APPROVED
}

model Review {
  id    String      @id @default(cuid(2))
  state ReviewState @default(PENDING)
}
```

Good enum candidates: lifecycle, workflow, provenance, verification, delivery,
sync, moderation, import/export, processing, and policy fields. A Boolean is
still fine for inherently binary independent switches (`disabled`, `required`,
`checked`, a protocol-level `isDefault`) or package-owned data whose package
documents a Boolean shape. For package-owned models, keep the package's
recommended format rather than forcing this repo's enum convention.

The same rule applies to oRPC contracts: if a procedure input or return value
represents an extensible state, expose a Zod enum/string-literal union rather
than `z.boolean()`.

### Prisma enum serialization gotcha

Prisma enum fields serialize as objects (not plain strings) over JSON. If a procedure returns a model with an enum field, the client receives `{ value: "PUBLISHED" }` instead of `"PUBLISHED"`. See [server-procedures.md § Prisma enum serialization](./server-procedures.md) for the `serializeX()` pattern.

## Multi-file schema

This repo splits the schema across multiple files in `packages/db/prisma/schema/`:

- `schema.prisma` — generator + datasource block only
- `auth.prisma` — Better-Auth models (`User`, `Session`, `Account`, etc.)
- `assets.prisma` — uploaded asset metadata
- `chat.prisma` — chat sessions and messages (removable)

That is the complete set. Both sides of cross-file relations must be declared, exactly the same as single-file relations. All model and enum names must be globally unique across all files.

When adding a new domain (e.g., billing, notifications), give it its own `<domain>.prisma` file rather than appending to `schema.prisma`. Keep the `generator` and `datasource` blocks in `schema.prisma`.

## Table names (`@@map`)

Every model in this repo declares `@@map("snake_case_name")` so the SQL table name uses snake_case while the Prisma client accessor stays camelCase. The Prisma client always derives the accessor from the model name, so `model PushSubscription` becomes `prisma.pushSubscription` regardless of `@@map`; the directive only renames the underlying SQL table.

```prisma
model PushSubscription {
  // ...fields
  @@map("push_subscription")  // model PushSubscription → prisma.pushSubscription → table push_subscription
}
```

The Better-Auth-owned `TwoFactor` model is renamed to `two_factor` via `@@map` so the SQL side follows the repo convention. This is safe because Better-Auth's Prisma adapter routes through the Prisma client accessor (`prisma.twoFactor`), not the SQL table name — see the carve-outs section below.

## Better-Auth carve-outs

The `User`, `Session`, `Account`, `Verification`, and `TwoFactor` models in `packages/db/prisma/schema/auth.prisma` follow Better-Auth's expected shape rather than the conventions above in a few documented ways. Do not "fix" these without first verifying the Better-Auth adapter still works:

- **`User.role` is `String` (not an enum)** because Better-Auth's admin plugin supports comma-separated multi-roles (e.g. `"admin,editor"`) — an enum cannot represent that.
- **Better-Auth Boolean columns stay Boolean** (`emailVerified`, `banned`, `twoFactorEnabled`, `TwoFactor.verified`) because Better-Auth owns those contracts and documents them as Booleans.
- **`User.banExpires` is `DateTime?`** to match what Better-Auth's admin plugin actually writes. The plugin declares the field as `"date"` in its schema and `routes.mjs` writes a JS `Date` at unban-by-deadline time; the Prisma adapter does not coerce between Date and Int, so `Int?` would throw `P2007`-class errors at write time. Verified against `better-auth` source (admin plugin `schema.mjs` + `routes.mjs`, core adapter `factory.mjs`).
- **A status column owned by a Better-Auth plugin stays `String` (not an enum)** whenever the plugin owns the value set and adds states across versions.
- **Lowercase relation fields on `User`** (`sessions`, `accounts`, `twoFactors`) and matching lowercase `user` back-refs on `Session` / `Account` / `TwoFactor` are **load-bearing** — `Session.user` and `User.accounts` are actively traversed by Better-Auth's internal adapter (`@better-auth/prisma-adapter`'s `getJoinKeyName` lowercases + plural-suffixes the joined model name). The other lowercase back-refs aren't currently traversed but follow the same pattern in case a future plugin upgrade adds `join: { ... }` against them. Renaming any of these to PascalCase breaks sign-in (`getSessionFromCtx`) and user lookup.
- **`@@map("two_factor")` in `auth.prisma` IS compatible with Better-Auth** because the adapter routes through Prisma client accessors (`prisma.twoFactor`), not SQL table names. The rename lets the SQL side follow the repo's snake_case convention without breaking the integration.

When extending these models with non-Better-Auth fields, follow the repo conventions in the rest of this doc.

## Connection pool size and transaction-mode poolers

The shared Prisma client (`packages/db/src/index.ts`) sizes its Postgres pool with `DATABASE_POOL_MAX` (default 10, the node-postgres default) — raise it only against the database's connection budget, remembering that every server and worker replica holds its own pool. If Postgres sits behind a transaction-mode pooler (PgBouncer in transaction mode, or a managed pooler with the same semantics), note that the Prisma driver adapter ignores a `?pgbouncer=true` query parameter: it still issues prepared statements, which a transaction-mode pooler cannot honor across checkouts, so queries fail with prepared-statement errors. The remedy is to run the pooler in session mode, or to disable prepared statements at the pg level.

## Best-practices checklist

When creating or updating a Prisma model, verify:

- [ ] `id`, `createdAt`, `updatedAt` are present
- [ ] `updatedAt` uses `@default(now()) @updatedAt` (not `@updatedAt` alone)
- [ ] Models in public URLs have a **human-readable** `slug` (or `username` / `handle`) with **no** `@default(cuid(2))` — a slug defaulted to a cuid2 is a primary key in disguise
- [ ] Models whose URL must stay unguessable use `publicId String @unique @default(cuid(2))`, not the raw `id`
- [ ] Every relationship is explicit and bidirectional
- [ ] Every foreign key uses the `xId` naming convention
- [ ] Every relation declares `onDelete` (and `onUpdate` if non-default)
- [ ] Models with multiple relations to the same target use named relations
- [ ] Every foreign key has an `@@index([xId])`
- [ ] Fields used in `WHERE` / `ORDER BY` / `JOIN` are indexed
- [ ] Compound indexes use `[equality_field, range_field]` order
- [ ] Unique constraints are declared (single-field and composite as needed)
- [ ] Frequently repeated strings are normalized into their own model
- [ ] Enums (not free-form strings) are used for fixed value sets
- [ ] Money amounts use integer minor units (or `Decimal`) with an explicit currency — never `Float`
- [ ] Owned extensible state uses enums, not Booleans, in both Prisma and oRPC contracts
- [ ] Junction tables follow the `<ModelA>On<ModelB>` naming pattern
- [ ] Ordering uses integer `order` with gaps of 100, not consecutive integers
- [ ] Table name is set via `@@map("snake_case_name")`
- [ ] After saving, you ran `pnpm db:push` and reviewed the diff summary Prisma printed

## Formatting

Align fields consistently, group related fields together, and place `@@index` / `@@unique` at the bottom of the model:

```prisma
model Category {
  id           String   @id @default(cuid(2))
  createdAt    DateTime @default(now())
  updatedAt    DateTime @default(now()) @updatedAt
  slug         String   @unique
  name         String
  isPublished  Boolean  @default(false)
  showInNavbar Boolean  @default(false)
  order        Int?
  Articles     Article[]

  @@index([order])
}
```

Prisma's formatter (`prisma format`) handles most of this automatically — `pnpm db:validate` runs it (and checks the result) as part of schema validation.
