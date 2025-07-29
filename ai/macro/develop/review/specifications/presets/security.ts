import { MetricSpecifications } from "../../types";

export default {

  "security": {
    weight: 0.4,
    target: 0.8,
    description: "Security is a measure of how secure the code is. It is a measure of how well the code protects against common security vulnerabilities and bad practices that creates security vulnerabilities."
  },
  
  "performance": {
    weight: 0.2,
    target: 0.8,
    description: "Performance is a measure of how well the code performs. It is a measure of how well the code performs under load and how well it scales."
  },

  "localization": {
    weight: 0.2,
    target: 0.8,
    description: "Localization is a measure of how localized the code is. It is a measure of how easy it is to localize the code and how easy it is to internationalize the code."
  },

  "interoperability": {
    weight: 0.2,
    target: 0.8,
    description: "Interoperability is a measure of how interoperable the code is. It is a measure of how interoperable the code is and how interoperable the code is written."
  },
} as MetricSpecifications;
