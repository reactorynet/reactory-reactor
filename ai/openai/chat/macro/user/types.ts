/**
 * User macro property interfaces
 */

/**
 * Properties for GetUser macro
 */
export interface GetUserProps {
  /** The email address of the user to find */
  email: string;
}

/**
 * Properties for CreateUser macro
 */
export interface CreateUserProps {
  /** The email address of the new user */
  email: string;
  /** The first name of the new user */
  firstName: string;
  /** The last name of the new user */
  lastName: string;
}