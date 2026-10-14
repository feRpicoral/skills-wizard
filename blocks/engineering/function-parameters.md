---
title: Function parameters
summary: Named interfaces and destructuring for multi-parameter functions
group: engineering
scopes: [global, project]
defaults: [global, project]
---

## Function parameters

- Use a single object parameter instead of positional parameters when:
  - two or more parameters share the same type, or
  - the function takes more than 3 parameters, regardless of their types.
- Define the parameter object in a named `interface` above the function, never as an inline `{ ... }` type literal in the signature.
- Consume the parameter object by destructuring in the signature (and `...rest` when forwarding remaining fields) rather than reading `params.field` or `params['field']` in the body.

Prefer:

```ts
interface TransferFundsParams {
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
}

function transferFunds({
  fromAccountId,
  toAccountId,
  amountCents,
}: TransferFundsParams): TransferReceipt {
  return ledger.record({ fromAccountId, toAccountId, amountCents });
}

interface SendInviteParams {
  organizationId: string;
  email: string;
  role: MemberRole;
  expiresAt: Date;
}

function sendInvite({
  organizationId,
  ...invite
}: SendInviteParams): Promise<Invite> {
  return mailer.sendOrganizationInvite(organizationId, invite);
}
```

Avoid:

```ts
function transferFunds(
  fromAccountId: string,
  toAccountId: string,
  amountCents: number,
): TransferReceipt {
  return ledger.record({ fromAccountId, toAccountId, amountCents });
}

function sendInvite(params: {
  organizationId: string;
  email: string;
  role: MemberRole;
  expiresAt: Date;
}): Promise<Invite> {
  return mailer.sendOrganizationInvite(params['organizationId'], {
    email: params.email,
    role: params.role,
    expiresAt: params.expiresAt,
  });
}
```
