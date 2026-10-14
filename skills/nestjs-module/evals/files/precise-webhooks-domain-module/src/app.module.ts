import { Module } from '@nestjs/common';

import { PrismaModule } from './modules/prisma/prisma.module.ts';

@Module({
  imports: [PrismaModule],
})
export class AppModule {}
