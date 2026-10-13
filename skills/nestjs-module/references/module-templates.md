# NestJS Domain Module Templates Reference

## File Layout

Every domain module under `src/modules/<domain>/` (or `src/<domain>/`) follows kebab-case naming with role suffixes:

- `<domain>.dto.ts` (or `<domain>.schema.ts` + `<domain>.dto.ts`)
- `<domain>.repository.ts`
- `<domain>.service.ts`
- `<domain>.controller.ts`
- `<domain>.module.ts`
- `<domain>.service.spec.ts`

## 1. `<domain>.dto.ts`

```ts
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createWebhookEndpointSchema = z.object({
  organizationId: z.string().uuid(),
  url: z.string().url(),
  events: z.array(z.string().min(1)).min(1),
});

export const webhookEndpointResponseSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  url: z.string().url(),
  events: z.array(z.string()),
  active: z.boolean(),
});

export class CreateWebhookEndpointDto extends createZodDto(
  createWebhookEndpointSchema,
) {}

export class WebhookEndpointResponseDto extends createZodDto(
  webhookEndpointResponseSchema,
) {}
```

## 2. `<domain>.repository.ts`

Only the repository imports and injects `PrismaService`. When a repository method takes two or more parameters of the same type (such as `organizationId: string` and `endpointId: string`) or more than 3 parameters, define a named `interface` and destructure it in the signature:

```ts
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.ts';
import type { CreateWebhookEndpointDto } from './webhooks.dto.ts';

export interface FindOrganizationEndpointParams {
  organizationId: string;
  endpointId: string;
}

export interface FindByUrlParams {
  organizationId: string;
  url: string;
}

@Injectable()
export class WebhooksRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById({ organizationId, endpointId }: FindOrganizationEndpointParams) {
    return this.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, organizationId },
    });
  }

  findByUrl({ organizationId, url }: FindByUrlParams) {
    return this.prisma.webhookEndpoint.findFirst({
      where: { organizationId, url },
    });
  }

  create(data: CreateWebhookEndpointDto) {
    return this.prisma.webhookEndpoint.create({
      data: {
        organizationId: data.organizationId,
        url: data.url,
        events: data.events,
        active: true,
      },
    });
  }
}
```

Note: always use a named `interface` above the class (`interface FindByUrlParams { organizationId: string; url: string }`) rather than an inline `{ ... }` type literal in the method signature.

## 3. `<domain>.service.ts`

```ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type {
  CreateWebhookEndpointDto,
  WebhookEndpointResponseDto,
} from './webhooks.dto.ts';
import {
  type FindOrganizationEndpointParams,
  WebhooksRepository,
} from './webhooks.repository.ts';

@Injectable()
export class WebhooksService {
  constructor(private readonly webhooksRepository: WebhooksRepository) {}

  async getEndpoint({
    organizationId,
    endpointId,
  }: FindOrganizationEndpointParams): Promise<WebhookEndpointResponseDto> {
    const endpoint = await this.webhooksRepository.findById({
      organizationId,
      endpointId,
    });
    if (!endpoint) {
      throw new NotFoundException(`Webhook endpoint ${endpointId} not found`);
    }
    return endpoint;
  }

  async createEndpoint(
    dto: CreateWebhookEndpointDto,
  ): Promise<WebhookEndpointResponseDto> {
    return this.webhooksRepository.create(dto);
  }
}
```

## 4. `<domain>.controller.ts`

```ts
import { Body, Controller, Get, HttpStatus, Param, Post } from '@nestjs/common';
import { ZodResponse } from 'nestjs-zod';

import {
  CreateWebhookEndpointDto,
  WebhookEndpointResponseDto,
} from './webhooks.dto.ts';
import { WebhooksService } from './webhooks.service.ts';

@Controller('organizations/:organizationId/webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Get(':endpointId')
  @ZodResponse({ type: WebhookEndpointResponseDto, status: HttpStatus.OK })
  getEndpoint(
    @Param('organizationId') organizationId: string,
    @Param('endpointId') endpointId: string,
  ): Promise<WebhookEndpointResponseDto> {
    return this.webhooksService.getEndpoint({ organizationId, endpointId });
  }

  @Post()
  @ZodResponse({
    type: WebhookEndpointResponseDto,
    status: HttpStatus.CREATED,
  })
  createEndpoint(
    @Body() body: CreateWebhookEndpointDto,
  ): Promise<WebhookEndpointResponseDto> {
    return this.webhooksService.createEndpoint(body);
  }
}
```

Note on NestJS controller methods: NestJS parameter decorators (`@Param`, `@Body`, `@Query`) bind to positional controller parameters at the HTTP boundary; the controller immediately packages multiple same-type values into the named parameter object passed to the service.

## 5. `<domain>.module.ts`

```ts
import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.ts';
import { WebhooksController } from './webhooks.controller.ts';
import { WebhooksRepository } from './webhooks.repository.ts';
import { WebhooksService } from './webhooks.service.ts';

@Module({
  imports: [PrismaModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhooksRepository],
  exports: [WebhooksService],
})
export class WebhooksModule {}
```

## 6. `<domain>.service.spec.ts`

Arrange, act, and assert phases are separated by a single empty line with no phase comments:

```ts
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';

import type { WebhooksRepository } from './webhooks.repository.ts';
import { WebhooksService } from './webhooks.service.ts';

describe('WebhooksService', () => {
  it('returns the endpoint when it belongs to the organization', async () => {
    const record = {
      id: '01950000-0000-7000-8000-000000000001',
      organizationId: '01950000-0000-7000-8000-000000000002',
      url: 'https://example.com/webhooks',
      events: ['invoice.paid'],
      active: true,
    };
    const repository = {
      findById: jest.fn().mockResolvedValue(record),
      create: jest.fn(),
    } as unknown as WebhooksRepository;
    const service = new WebhooksService(repository);

    const result = await service.getEndpoint({
      organizationId: record.organizationId,
      endpointId: record.id,
    });

    expect(result).toEqual(record);
    expect(repository.findById).toHaveBeenCalledWith({
      organizationId: record.organizationId,
      endpointId: record.id,
    });
  });

  it('throws NotFoundException when the endpoint does not exist', async () => {
    const repository = {
      findById: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    } as unknown as WebhooksRepository;
    const service = new WebhooksService(repository);

    const act = service.getEndpoint({
      organizationId: '01950000-0000-7000-8000-000000000002',
      endpointId: '01950000-0000-7000-8000-000000000099',
    });

    await expect(act).rejects.toThrow(NotFoundException);
  });
});
```
