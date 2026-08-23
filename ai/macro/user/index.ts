import {
  GetUser,
  GetUserRegistry,
  SearchUser,
  SearchUserRegistry,
  CreateUser,
  CreateUserRegistry,
} from "./macro";

export * from "./types";
export * from "./macro";

export const UserMacros = [
  GetUserRegistry,
  SearchUserRegistry,
  CreateUserRegistry,
];

export default UserMacros;
