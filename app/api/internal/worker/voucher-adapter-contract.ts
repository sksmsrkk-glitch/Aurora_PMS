/** Stable provider contract that makes voucher retries externally idempotent. */
export function voucherAdapterRequest(input: {
  deliveryId: string;
  secret: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  propertyId: string;
  reservationId: string;
  language: unknown;
  showAmount: unknown;
}) {
  return {
    body: {
      messageId: input.deliveryId,
      from: input.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      metadata: {
        propertyId: input.propertyId,
        reservationId: input.reservationId,
        language: input.language,
        showAmount: input.showAmount,
      },
    },
    headers: {
      Authorization: `Bearer ${input.secret}`,
      "Idempotency-Key": input.deliveryId,
    },
  };
}
