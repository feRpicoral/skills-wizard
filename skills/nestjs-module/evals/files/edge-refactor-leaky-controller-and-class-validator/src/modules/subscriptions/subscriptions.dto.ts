import { IsEnum, IsInt, IsUUID, Min } from 'class-validator';

export class CreateSubscriptionDto {
  @IsUUID()
  organizationId!: string;

  @IsEnum(['starter', 'pro', 'enterprise'])
  plan!: 'starter' | 'pro' | 'enterprise';

  @IsInt()
  @Min(1)
  seats!: number;
}
