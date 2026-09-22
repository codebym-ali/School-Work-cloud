import { Module } from '@nestjs/common';
import { FeesModule } from '../fees/fees.module';
import { WithdrawalService } from './withdrawal.service';
import { WithdrawalController } from './withdrawal.controller';

/** Student withdrawal (blueprint §15). Withdrawal closes invoices already raised for months after
 *  the student left (see withdraw()), so it depends on the fees module. */
@Module({
  imports: [FeesModule],
  controllers: [WithdrawalController],
  providers: [WithdrawalService],
  exports: [WithdrawalService],
})
export class WithdrawalModule {}
