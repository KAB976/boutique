import React from 'react';
import { createPortal } from 'react-dom';

/**
 * Signature « KAB » : affichée sur tous les écrans (connexion comprise) et sur chaque page imprimée / PDF.
 * Elle est placée directement dans <body> (hors de #root) pour rester visible quand on imprime une fiche.
 */
export default function Signature() {
  return createPortal(<div className="kab-sign" aria-hidden="true">KAB</div>, document.body);
}
