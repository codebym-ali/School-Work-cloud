import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AccessModule } from '../access/access.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/** Users & roles management (blueprint §23). AuthModule provides PasswordService. */
@Module({
  imports: [AuthModule, AccessModule],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
