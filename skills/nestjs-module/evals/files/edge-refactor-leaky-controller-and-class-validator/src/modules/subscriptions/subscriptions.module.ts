import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.ts';
import { SubscriptionsController } from './subscriptions.controller.ts';
import { SubscriptionsService } from './subscriptions.service.ts';

@Module({
  imports: [PrismaModule],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
