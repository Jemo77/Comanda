import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentSession, RequirePermissions } from '../../common/authz/permissions.guard';
import type { SessionPrincipal } from '../../common/authz/principal';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ReportsService } from './reports.service';

const salesQuerySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  groupBy: z.enum(['day', 'product', 'category']).default('day'),
});

@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('sales')
  @RequirePermissions('report.read')
  @ApiOperation({ summary: 'Ventas por dia, producto o categoria (centavos)' })
  async sales(
    @CurrentSession() session: SessionPrincipal,
    @Query(new ZodValidationPipe(salesQuerySchema)) query: z.infer<typeof salesQuerySchema>,
  ) {
    return this.reports.sales(session.orgId, session.venueId, {
      from: new Date(query.from),
      to: new Date(query.to),
      groupBy: query.groupBy,
    });
  }
}
