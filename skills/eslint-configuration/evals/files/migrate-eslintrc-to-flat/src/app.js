/* eslint-env browser */
import { renderWidget } from "./widget.js";

const root = document.getElementById("app");
renderWidget(root, { title: "Revenue" });
