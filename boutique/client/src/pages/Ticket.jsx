import React from 'react';
import { createPortal } from 'react-dom';
import { eur, METHODS, fmtDT } from '../money.js';

/** Contenu d'un ticket (écran et impression). Aucun coût n'y figure. */
export function TicketBody({ sale, shop, tz, provisional }) {
  const lines = sale.lines || [];
  const vatBy = {};
  for (const l of lines) {
    if (l.vat_pct > 0) { vatBy[l.vat_pct] = (vatBy[l.vat_pct] || 0) + Math.round((l.total_cents * l.vat_pct) / (100 + l.vat_pct)); }
  }
  const isRefund = sale.kind === 'refund';
  return (
    <div className="ticket">
      {shop?.logo && <img src={shop.logo} alt="" className="ticket-logo" />}
      <div className="ticket-shop">{shop?.shop_name}</div>
      {shop?.address && <div className="ticket-small">{shop.address}</div>}
      {shop?.phone && <div className="ticket-small">Tél. {shop.phone}</div>}
      <hr />
      <div className="ticket-small">{isRefund ? 'ANNULATION' : 'Ticket'} {provisional ? <strong>{provisional} (hors-ligne)</strong> : sale.number}</div>
      <div className="ticket-small">{fmtDT(sale.ts, tz)}{sale.user_name ? ` · ${sale.user_name}` : ''}</div>
      {sale.customer && <div className="ticket-small">Client : {sale.customer.name}</div>}
      {isRefund && sale.refund_of_sale && <div className="ticket-small">Annule le ticket {sale.refund_of_sale.number}</div>}
      <hr />
      <table>
        <tbody>
          {lines.map((l, i) => (
            <React.Fragment key={i}>
              <tr><td>{Math.abs(l.qty)} × {l.name}</td><td className="r">{eur(l.gross_cents)}</td></tr>
              {l.discount_cents !== 0 && <tr className="ticket-small"><td>&nbsp;&nbsp;{l.promo_label || 'Remise'}</td><td className="r">{eur(-l.discount_cents)}</td></tr>}
            </React.Fragment>
          ))}
        </tbody>
      </table>
      <hr />
      <table>
        <tbody>
          <tr className="ticket-total"><td>TOTAL TTC</td><td className="r">{eur(sale.total_cents)}</td></tr>
          {Object.entries(vatBy).map(([pct, v]) => <tr key={pct} className="ticket-small"><td>dont TVA {pct} %</td><td className="r">{eur(sale.kind === 'refund' ? -Math.abs(v) : v)}</td></tr>)}
          {(sale.payments || []).map((p, i) => <tr key={i}><td>{METHODS[p.method] || p.method}</td><td className="r">{eur(p.amount_cents)}</td></tr>)}
          {sale.change_cents > 0 && <tr><td>Rendu</td><td className="r">{eur(sale.change_cents)}</td></tr>}
        </tbody>
      </table>
      <hr />
      <div className="ticket-small center-text">{shop?.footer || shop?.ticket_footer}</div>
    </div>
  );
}

export function PrintTicket(props) {
  return createPortal(<div className="print-sheet ticket-sheet"><TicketBody {...props} /></div>, document.body);
}
