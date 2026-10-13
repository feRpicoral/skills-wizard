import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.ts';

@Injectable()
export class SubscriptionsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSubscription(organizationId: string, subscriptionId: string) {
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        id: subscriptionId,
        organizationId,
      },
    });
    if (!subscription) {
      throw new NotFoundException(
        `Subscription ${subscriptionId} not found for organization ${organizationId}`,
      );
    }
    return subscription;
  }
}
