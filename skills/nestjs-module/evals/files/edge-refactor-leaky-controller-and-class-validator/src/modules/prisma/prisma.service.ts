import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor() {
    super({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_TRANSACTION_POOLING_URL,
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }
}
