import { Body, Controller, Get, Param, Post } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.ts';
import { CreateSubscriptionDto } from './subscriptions.dto.ts';
import { SubscriptionsService } from './subscriptions.service.ts';

@Controller('organizations/:organizationId/subscriptions')
export class SubscriptionsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptionsService: SubscriptionsService,
  ) {}

  @Get(':subscriptionId')
  getSubscription(
    @Param('organizationId') organizationId: string,
    @Param('subscriptionId') subscriptionId: string,
  ) {
    return this.subscriptionsService.getSubscription(
      organizationId,
      subscriptionId,
    );
  }

  @Post()
  createSubscription(@Body() body: CreateSubscriptionDto) {
    return this.prisma.subscription.create({
      data: {
        organizationId: body.organizationId,
        plan: body.plan,
        seats: body.seats,
        status: 'active',
      },
    });
  }
}
